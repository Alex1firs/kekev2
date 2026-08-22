/**
 * Waking a driver's phone so a stale device can be dispatched to.
 *
 * ── Why this exists ─────────────────────────────────────────────────────
 * A driver who has said they are ONLINE keeps that intent forever. But their
 * phone may have gone quiet — Doze, an OEM battery manager, a tunnel, iOS
 * suspending the isolate. We must not dispatch against a position that is
 * hours old, and we must not drop the driver either.
 *
 * So we knock. A high-priority, data-only push wakes the app's background
 * isolate; the app re-authenticates, reconnects its socket, takes a fresh GPS
 * fix and posts a heartbeat. That heartbeat is what makes the driver
 * dispatchable — not the wake itself, and never the old coordinates.
 *
 * This is the mechanism Bolt and Uber use: the push IS the wake-up.
 *
 * ── Data-only, deliberately ─────────────────────────────────────────────
 * A `notification` block would be handled by the system tray and would show
 * the driver a pointless "wake up" alert. A data-only message is invisible and
 * runs the app's background handler instead, which is the entire point. The
 * ride OFFER that follows is a separate, visible push.
 */
import * as admin from 'firebase-admin';
import { AppDataSource } from '../config/data_source';
import { DeviceToken } from '../models/DeviceToken';
import { UserRole } from '../models/User';
import { DriverIntentService } from './driver_intent_service';
import { NotificationService } from './notification_service';
import { redis } from '../config/redis';

/** How long we wait for a woken phone to post a fresh heartbeat. */
const WAKE_ANSWER_TIMEOUT_MS = Number(process.env.DRIVER_WAKE_TIMEOUT_MS || 6_000);
/** Minimum gap between wakes to one device, so a demand burst is not a wake burst. */
const WAKE_COOLDOWN_MS = Number(process.env.DRIVER_WAKE_COOLDOWN_MS || 20_000);

export interface WakeResult {
    driverId: string;
    attempted: boolean;
    answered: boolean;
    /** A fresh fix, if the phone produced one in time. */
    freshPosition: { lat: number; lng: number; at: number } | null;
    reason?: string;
}

export class DriverWakeService {
    /**
     * Knock on one driver's phone and wait briefly for it to answer.
     *
     * "Answered" means a heartbeat landed — the availability key exists again.
     * Nothing else counts, because nothing else proves the device is really
     * there and really knows where it is.
     */
    static async wake(driverId: string, context: { rideId?: string } = {}): Promise<WakeResult> {
        const cooldownKey = `driver:wake:${driverId}`;
        // NX + PX: the first caller in the window wins and the rest see the key
        // already set. Atomic, so ten simultaneous ride requests produce one wake.
        const claimed = await redis.set(cooldownKey, '1', 'PX', WAKE_COOLDOWN_MS, 'NX');
        if (claimed !== 'OK') {
            // Somebody just woke them. Give the answer a moment to arrive
            // rather than reporting a failure that is really a race.
            const already = await this.waitForHeartbeat(driverId, WAKE_ANSWER_TIMEOUT_MS);
            return {
                driverId, attempted: false, answered: already !== null,
                freshPosition: already, reason: 'wake_already_in_flight',
            };
        }

        const tokens = await AppDataSource.getRepository(DeviceToken).find({
            where: { userId: driverId, role: UserRole.DRIVER, isActive: true },
        });
        if (tokens.length === 0) {
            await DriverIntentService.recordWakeAttempt(driverId, false);
            return { driverId, attempted: false, answered: false, freshPosition: null, reason: 'no_push_token' };
        }

        /*
         * Make sure Firebase is initialised before touching messaging().
         *
         * NotificationService lazily initialises on its first send, and every
         * other push path goes through it. A wake does not, so on a freshly
         * booted process whose first outbound push happens to be a wake,
         * admin.messaging() would throw "default Firebase app does not exist"
         * and the driver would silently never be knocked on.
         */
        if (!NotificationService.isReady()) {
            await DriverIntentService.recordWakeAttempt(driverId, false);
            return {
                driverId, attempted: false, answered: false, freshPosition: null,
                reason: 'push_not_configured',
            };
        }

        let accepted = 0;
        let rejected: string[] = [];
        try {
            const fcm = await admin.messaging().sendEachForMulticast({
                tokens: tokens.map((t) => t.token),
                /*
                 * No `notification` block. This message must be invisible to
                 * the driver and must run their app's background handler.
                 */
                data: {
                    type: 'PRESENCE_WAKE',
                    rideId: context.rideId ?? '',
                    requestedAt: String(Date.now()),
                },
                android: {
                    priority: 'high',
                    // Bypasses Doze's deferral for data messages.
                    ttl: 30_000,
                },
                apns: {
                    headers: {
                        // 5 = background push, the only priority Apple permits
                        // for a content-available message, and the header that
                        // makes iOS run the app rather than queue it.
                        'apns-priority': '5',
                        'apns-push-type': 'background',
                        'apns-expiration': String(Math.floor(Date.now() / 1000) + 30),
                    },
                    payload: {
                        aps: {
                            // Wakes a suspended iOS app for background execution.
                            // Without this the message is simply not delivered
                            // to a backgrounded app at all.
                            contentAvailable: true,
                        },
                    },
                },
            });
            /*
             * Inspect what FCM actually said, rather than assuming a resolved
             * promise means delivered.
             *
             * The first field test could not distinguish "FCM rejected the
             * token" from "the phone ignored us" — both looked like
             * answered:false — and diagnosing it needed a manual probe. A
             * rejected token is also the one failure we can repair: retire it
             * so the driver's live tokens stay honest.
             */
            accepted = fcm.successCount;
            fcm.responses.forEach((r, i) => {
                if (r.success) return;
                const code = (r.error as any)?.code ?? 'unknown';
                rejected.push(code);
                if (code === 'messaging/registration-token-not-registered'
                    || code === 'messaging/invalid-registration-token') {
                    void AppDataSource.getRepository(DeviceToken)
                        .update({ token: tokens[i].token }, { isActive: false })
                        .catch(() => undefined);
                }
            });
        } catch (err: any) {
            await DriverIntentService.recordWakeAttempt(driverId, false);
            return {
                driverId, attempted: true, answered: false, freshPosition: null,
                reason: `wake_send_failed:${err?.message ?? 'unknown'}`,
            };
        }

        if (accepted === 0) {
            await DriverIntentService.recordWakeAttempt(driverId, false);
            console.log(JSON.stringify({
                level: 'warn', scope: 'presence', event: 'wake_rejected',
                driverId, tokens: tokens.length, rejected,
            }));
            return {
                driverId, attempted: true, answered: false, freshPosition: null,
                reason: `fcm_rejected_all:${rejected.join(',')}`,
            };
        }

        const fresh = await this.waitForHeartbeat(driverId, WAKE_ANSWER_TIMEOUT_MS);
        await DriverIntentService.recordWakeAttempt(driverId, fresh !== null);

        console.log(JSON.stringify({
            level: 'info', scope: 'presence', event: 'wake',
            driverId, answered: fresh !== null, rideId: context.rideId ?? null,
            // Delivery is now separable from response: FCM accepting the
            // message and the handset answering are different facts.
            fcmAccepted: accepted, fcmRejected: rejected.length ? rejected : undefined,
            waitedMs: WAKE_ANSWER_TIMEOUT_MS,
        }));

        return {
            driverId, attempted: true, answered: fresh !== null,
            freshPosition: fresh,
            reason: fresh ? undefined : `no_answer_within_${WAKE_ANSWER_TIMEOUT_MS}ms`,
        };
    }

    /** Wake several drivers at once and return only those that answered. */
    static async wakeMany(
        driverIds: string[],
        context: { rideId?: string } = {},
    ): Promise<WakeResult[]> {
        return Promise.all(driverIds.map((id) => this.wake(id, context)));
    }

    /**
     * Poll for the availability key the woken phone's heartbeat will set.
     *
     * Polling rather than a subscription because the heartbeat arrives over
     * HTTP on any one of several backend instances; the key in shared Redis is
     * the one place every instance agrees on.
     */
    private static async waitForHeartbeat(
        driverId: string,
        timeoutMs: number,
    ): Promise<{ lat: number; lng: number; at: number } | null> {
        const deadline = Date.now() + timeoutMs;
        const startedAt = Date.now();

        while (Date.now() < deadline) {
            const [available, posRaw] = await redis.mget(
                `driver:available:${driverId}`,
                `driver:lastpos:${driverId}`,
            );
            if (available === 'true' && posRaw) {
                try {
                    const pos = JSON.parse(posRaw);
                    // Only a fix taken since we knocked counts. An old position
                    // that happens to still be cached is exactly what this
                    // whole mechanism exists to avoid trusting.
                    if (typeof pos?.at === 'number' && pos.at >= startedAt - 2_000) return pos;
                } catch { /* fall through and keep waiting */ }
            }
            await new Promise((r) => setTimeout(r, 400));
        }
        return null;
    }
}
