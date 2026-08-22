/**
 * Driver work intent, and — kept deliberately apart from it — device health.
 *
 * ── The separation, stated once ─────────────────────────────────────────
 *
 *   INTENT   "I am working."        Durable. Only a decision changes it.
 *   HEALTH   "Your phone answered." Observed. Changes constantly. Never
 *                                   rewrites intent.
 *
 * Everything that used to remove a driver from dispatch — a missed heartbeat,
 * a dropped socket, a backgrounded app, a killed process, a stale fix — is
 * health. It now decides HOW we reach a driver, not WHETHER they want work.
 *
 * There is no code path in this file, or anywhere else, that turns ONLINE into
 * OFFLINE because time passed. That absence is the point of the whole change.
 */
import { AppDataSource } from '../config/data_source';
import { DriverPresenceIntent, PresenceIntent, IntentActor } from '../models/DriverPresenceIntent';
import { DeviceToken } from '../models/DeviceToken';
import { UserRole } from '../models/User';
import { DispatchService } from './dispatch_service';
import { redis } from '../config/redis';

/**
 * What we currently know about a driver's device.
 *
 * FRESH        beat recently; dispatch may use the stored position as-is.
 * STALE        intent ONLINE, device quiet. Reachable only by waking it, and
 *              its stored position must NOT be trusted for dispatch.
 * UNREACHABLE  intent ONLINE, wakes unanswered. Visible as a problem; the
 *              driver stays ONLINE and one heartbeat restores them.
 * OFFLINE      the driver said they are not working.
 */
export type Reachability = 'FRESH' | 'STALE' | 'UNREACHABLE' | 'OFFLINE';

export interface DriverHealth {
    driverId: string;
    intent: PresenceIntent;
    reachability: Reachability;
    heartbeatAgeSeconds: number | null;
    locationAgeSeconds: number | null;
    hasPushToken: boolean;
    lastKnownPosition: { lat: number; lng: number; at: number } | null;
    failedWakeCount: number;
}

/** Wakes unanswered before we call a device UNREACHABLE. */
const UNREACHABLE_AFTER_FAILED_WAKES = 3;

export class DriverIntentService {
    private static get repo() { return AppDataSource.getRepository(DriverPresenceIntent); }

    // ── Intent ──────────────────────────────────────────────────────────

    /**
     * Record that a driver wants work. Idempotent.
     *
     * Deliberately does NOT touch the availability key: going online is a
     * statement of intent, and the device proves itself separately by beating.
     */
    static async setOnline(
        driverId: string,
        setBy: IntentActor = IntentActor.DRIVER,
        actorId: string | null = null,
        reason: string | null = null,
    ): Promise<DriverPresenceIntent> {
        const existing = await this.repo.findOne({ where: { driverId } });
        if (existing?.state === PresenceIntent.ONLINE) return existing;

        const row = this.repo.create({
            driverId,
            state: PresenceIntent.ONLINE,
            since: new Date(),
            setBy, actorId, reason,
            failedWakeCount: 0,
        });
        await this.repo.save(row);
        // A driver coming online is not "recently offline" any more.
        await DispatchService.clearOfflineTombstone(driverId).catch(() => undefined);
        console.log(JSON.stringify({
            level: 'info', scope: 'presence', event: 'intent_online', driverId, setBy,
        }));
        return row;
    }

    /**
     * Record that a driver has stopped working.
     *
     * The ONLY way out of ONLINE. Callers are the driver's toggle, a
     * deliberate logout, an admin, or an eligibility change — never a timer.
     */
    static async setOffline(
        driverId: string,
        setBy: IntentActor = IntentActor.DRIVER,
        actorId: string | null = null,
        reason: string | null = null,
    ): Promise<void> {
        await this.repo.save(this.repo.create({
            driverId,
            state: PresenceIntent.OFFLINE,
            since: new Date(),
            setBy, actorId, reason,
            failedWakeCount: 0,
        }));
        // Leaving on purpose DOES clear live availability — the driver has said
        // they are done, and must stop being dispatched immediately.
        await DispatchService.removeDriverAvailability(driverId);
        console.log(JSON.stringify({
            level: 'info', scope: 'presence', event: 'intent_offline', driverId, setBy, reason,
        }));
    }

    /**
     * A heartbeat arrived. Treat it as the driver declaring they are working,
     * and record that their device answered.
     *
     * ── Why a heartbeat counts as intent ────────────────────────────────
     * The shipped driver APK has no "go online" message. Going online IS the
     * heartbeat starting — the app begins beating when the driver flips the
     * toggle and stops when they flip it back. So the beat has always carried
     * the declaration; the platform simply forgot it 45 seconds later.
     *
     * Reading it as intent is what lets this change deploy to drivers already
     * in the field without an app release. A newer client can also declare
     * explicitly via setOnline(); both converge on the same row.
     *
     * The one guard: a beat still in flight when a driver toggles OFF must not
     * drag them back on. A deliberate OFFLINE set moments ago wins.
     */
    static async recordHeartbeat(driverId: string): Promise<void> {
        const existing = await this.repo.findOne({ where: { driverId } });

        if (existing?.state === PresenceIntent.OFFLINE) {
            const deliberate = existing.setBy === IntentActor.DRIVER
                || existing.setBy === IntentActor.ADMIN
                || existing.setBy === IntentActor.LOGOUT;
            const secondsSince = (Date.now() - new Date(existing.since).getTime()) / 1000;
            // A beat racing a fresh toggle-off is discarded; anything later is
            // the driver working again.
            if (deliberate && secondsSince < 60) {
                await this.repo.update({ driverId }, { lastReachableAt: new Date() });
                return;
            }
        }

        if (!existing || existing.state !== PresenceIntent.ONLINE) {
            await this.repo.save(this.repo.create({
                driverId,
                state: PresenceIntent.ONLINE,
                since: new Date(),
                setBy: IntentActor.SYSTEM,
                reason: 'Declared by heartbeat',
                lastReachableAt: new Date(),
                failedWakeCount: 0,
            }));
            await DispatchService.clearOfflineTombstone(driverId).catch(() => undefined);
            console.log(JSON.stringify({
                level: 'info', scope: 'presence', event: 'intent_online_via_heartbeat', driverId,
            }));
            return;
        }

        await this.repo.update({ driverId }, { lastReachableAt: new Date(), failedWakeCount: 0 });
    }

    static async get(driverId: string): Promise<DriverPresenceIntent | null> {
        return this.repo.findOne({ where: { driverId } });
    }

    static async isOnline(driverId: string): Promise<boolean> {
        const row = await this.repo.findOne({ where: { driverId } });
        return row?.state === PresenceIntent.ONLINE;
    }

    /** Every driver who has said they are working, however their phone is behaving. */
    static async onlineDriverIds(): Promise<string[]> {
        const rows = await this.repo.find({
            where: { state: PresenceIntent.ONLINE }, select: ['driverId'],
        });
        return rows.map((r) => r.driverId);
    }

    // ── Device health ───────────────────────────────────────────────────

    /**
     * A driver's device answered. Called from every heartbeat path.
     *
     * Clears the failed-wake counter, which is what makes recovery automatic:
     * connectivity returning is enough, with no toggle and no app reopen.
     */
    static async recordReachable(driverId: string): Promise<void> {
        await this.repo.update(
            { driverId },
            { lastReachableAt: new Date(), failedWakeCount: 0 },
        );
    }

    static async recordWakeAttempt(driverId: string, answered: boolean): Promise<void> {
        if (answered) return this.recordReachable(driverId);
        await this.repo.increment({ driverId }, 'failedWakeCount', 1);
        await this.repo.update({ driverId }, { lastWakeAttemptAt: new Date() });
    }

    /**
     * The full picture for one driver: what they want, and what their phone is
     * doing. Read-only — computing health never mutates intent.
     */
    static async healthOf(driverId: string): Promise<DriverHealth> {
        const [intentRow, available, lastSeenRaw, lastPosRaw, tokenCount] = await Promise.all([
            this.repo.findOne({ where: { driverId } }),
            redis.get(`driver:available:${driverId}`),
            redis.get(`${DispatchService.DRIVER_LASTSEEN_PREFIX}${driverId}`),
            redis.get(`${DispatchService.DRIVER_LASTPOS_PREFIX}${driverId}`),
            AppDataSource.getRepository(DeviceToken).count({
                where: { userId: driverId, role: UserRole.DRIVER, isActive: true },
            }),
        ]);

        const intent = intentRow?.state ?? PresenceIntent.OFFLINE;
        const now = Date.now();

        const heartbeatAgeSeconds = lastSeenRaw
            ? Math.max(0, Math.round((now - Number(lastSeenRaw)) / 1000)) : null;

        let lastKnownPosition: DriverHealth['lastKnownPosition'] = null;
        try { lastKnownPosition = lastPosRaw ? JSON.parse(lastPosRaw) : null; } catch { /* ignore */ }
        const locationAgeSeconds = lastKnownPosition
            ? Math.max(0, Math.round((now - lastKnownPosition.at) / 1000)) : null;

        const failedWakeCount = intentRow?.failedWakeCount ?? 0;

        let reachability: Reachability;
        if (intent !== PresenceIntent.ONLINE) {
            reachability = 'OFFLINE';
        } else if (available === 'true') {
            reachability = 'FRESH';
        } else if (tokenCount > 0 && failedWakeCount < UNREACHABLE_AFTER_FAILED_WAKES) {
            // Quiet, but we have a way to knock on the door.
            reachability = 'STALE';
        } else {
            // Either no push token at all, or repeated wakes went unanswered.
            // Still ONLINE — this is a device problem to surface, not a
            // decision to overwrite.
            reachability = 'UNREACHABLE';
        }

        return {
            driverId, intent, reachability,
            heartbeatAgeSeconds, locationAgeSeconds,
            hasPushToken: tokenCount > 0,
            lastKnownPosition, failedWakeCount,
        };
    }

    /** healthOf for many drivers, without N round trips per driver. */
    static async healthOfMany(driverIds: string[]): Promise<Map<string, DriverHealth>> {
        const out = new Map<string, DriverHealth>();
        if (driverIds.length === 0) return out;

        const [intents, availability, lastSeen, lastPos, tokenRows] = await Promise.all([
            this.repo.find({ where: driverIds.map((driverId) => ({ driverId })) }),
            redis.mget(...driverIds.map((id) => `driver:available:${id}`)),
            redis.mget(...driverIds.map((id) => `${DispatchService.DRIVER_LASTSEEN_PREFIX}${id}`)),
            redis.mget(...driverIds.map((id) => `${DispatchService.DRIVER_LASTPOS_PREFIX}${id}`)),
            AppDataSource.getRepository(DeviceToken)
                .createQueryBuilder('t')
                .select('t."userId"', 'userId')
                .addSelect('COUNT(*)', 'n')
                .where('t."userId" IN (:...ids)', { ids: driverIds })
                .andWhere('t.role = :role', { role: UserRole.DRIVER })
                .andWhere('COALESCE(t."isActive", true) = true')
                .groupBy('t."userId"')
                .getRawMany(),
        ]);

        const intentByDriver = new Map(intents.map((i) => [i.driverId, i]));
        const tokensByDriver = new Map(tokenRows.map((r: any) => [r.userId, Number(r.n)]));
        const now = Date.now();

        driverIds.forEach((driverId, i) => {
            const intentRow = intentByDriver.get(driverId);
            const intent = intentRow?.state ?? PresenceIntent.OFFLINE;
            const failedWakeCount = intentRow?.failedWakeCount ?? 0;
            const tokenCount = tokensByDriver.get(driverId) ?? 0;

            const seenRaw = lastSeen[i];
            const heartbeatAgeSeconds = seenRaw
                ? Math.max(0, Math.round((now - Number(seenRaw)) / 1000)) : null;

            let lastKnownPosition: DriverHealth['lastKnownPosition'] = null;
            try { lastKnownPosition = lastPos[i] ? JSON.parse(lastPos[i] as string) : null; } catch { /* ignore */ }
            const locationAgeSeconds = lastKnownPosition
                ? Math.max(0, Math.round((now - lastKnownPosition.at) / 1000)) : null;

            let reachability: Reachability;
            if (intent !== PresenceIntent.ONLINE) reachability = 'OFFLINE';
            else if (availability[i] === 'true') reachability = 'FRESH';
            else if (tokenCount > 0 && failedWakeCount < UNREACHABLE_AFTER_FAILED_WAKES) reachability = 'STALE';
            else reachability = 'UNREACHABLE';

            out.set(driverId, {
                driverId, intent, reachability,
                heartbeatAgeSeconds, locationAgeSeconds,
                hasPushToken: tokenCount > 0,
                lastKnownPosition, failedWakeCount,
            });
        });

        return out;
    }

    /** Fleet counts for the admin dashboard. */
    static async fleetSummary(): Promise<{
        online: number; fresh: number; stale: number; unreachable: number; offline: number;
    }> {
        const onlineIds = await this.onlineDriverIds();
        const health = await this.healthOfMany(onlineIds);
        const counts = { online: onlineIds.length, fresh: 0, stale: 0, unreachable: 0, offline: 0 };
        for (const h of health.values()) {
            if (h.reachability === 'FRESH') counts.fresh += 1;
            else if (h.reachability === 'STALE') counts.stale += 1;
            else if (h.reachability === 'UNREACHABLE') counts.unreachable += 1;
        }
        counts.offline = await this.repo.count({ where: { state: PresenceIntent.OFFLINE } });
        return counts;
    }
}
