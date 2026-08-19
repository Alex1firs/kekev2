/**
 * When Operations gets told about a ride, and how loudly.
 *
 * ── Configurable from the start ──────────────────────────────────────────
 * The brief for this rollout is RING FOR EVERY REQUEST: volume is low, and
 * every request is worth watching while adoption is being supervised. But that
 * posture has a shelf life measured in weeks — at a hundred rides an hour it
 * becomes noise, and noise is how a genuine "no drivers in Awada" gets missed.
 *
 * So the trigger set is data, not code. Switching to exception-only alerting
 * is a settings change, not an app release.
 */
import { SettingService } from './setting_service';
import { StaffPushService } from './staff_push_service';
import { AttentionTrigger, AttentionSeverity, QueueRow } from './operations_queue_service';
import { loadOperationsDispatchConfig } from '../config/operations_dispatch_config';

export type NotificationTrigger =
    | 'EVERY_REQUEST'
    | 'NO_ELIGIBLE_DRIVER'
    | 'NO_DRIVER_ACCEPTED'
    | 'WAIT_EXCEEDS_THRESHOLD'
    | 'TECHNICAL_FAILURE'
    | 'DISPATCH_EXHAUSTED';

export interface NotificationPolicy {
    /** Which events produce a push at all. */
    triggers: NotificationTrigger[];
    /** Triggers that should arrive as urgent rather than normal. */
    urgentTriggers: NotificationTrigger[];
    /** Master switch for Operations push, independent of the queue itself. */
    pushEnabled: boolean;
    /** Suppress repeat pushes for the same ride within this window. */
    dedupeWindowSeconds: number;
}

const SETTING_KEY = 'operations_notification_policy';

/**
 * The rollout default: ring for everything, and shout when there is no supply.
 *
 * Deliberately the loud posture. During early Onitsha operations a missed
 * request costs a passenger and a driver; a redundant buzz costs a moment.
 */
export const DEFAULT_POLICY: NotificationPolicy = {
    triggers: [
        'EVERY_REQUEST',
        'NO_ELIGIBLE_DRIVER',
        'NO_DRIVER_ACCEPTED',
        'WAIT_EXCEEDS_THRESHOLD',
        'TECHNICAL_FAILURE',
        'DISPATCH_EXHAUSTED',
    ],
    urgentTriggers: ['NO_ELIGIBLE_DRIVER', 'TECHNICAL_FAILURE', 'DISPATCH_EXHAUSTED'],
    pushEnabled: true,
    dedupeWindowSeconds: 120,
};

/** The quiet posture, for when volume grows. Not used yet; documented so the
 *  switch is a known, tested shape rather than an improvisation later. */
export const EXCEPTION_ONLY_POLICY: NotificationPolicy = {
    triggers: ['NO_ELIGIBLE_DRIVER', 'WAIT_EXCEEDS_THRESHOLD', 'TECHNICAL_FAILURE', 'DISPATCH_EXHAUSTED'],
    urgentTriggers: ['NO_ELIGIBLE_DRIVER', 'TECHNICAL_FAILURE'],
    pushEnabled: true,
    dedupeWindowSeconds: 300,
};

export class OperationsNotificationService {
    private static recentlyNotified = new Map<string, number>();

    static async policy(): Promise<NotificationPolicy> {
        try {
            const raw = await SettingService.getSetting(SETTING_KEY, '');
            if (!raw) return DEFAULT_POLICY;
            const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
            return {
                triggers: Array.isArray(parsed.triggers) ? parsed.triggers : DEFAULT_POLICY.triggers,
                urgentTriggers: Array.isArray(parsed.urgentTriggers)
                    ? parsed.urgentTriggers
                    : DEFAULT_POLICY.urgentTriggers,
                pushEnabled: parsed.pushEnabled !== false,
                dedupeWindowSeconds:
                    Number(parsed.dedupeWindowSeconds) || DEFAULT_POLICY.dedupeWindowSeconds,
            };
        } catch {
            // A malformed policy must not silence operations.
            return DEFAULT_POLICY;
        }
    }

    static async setPolicy(policy: NotificationPolicy): Promise<void> {
        await SettingService.setSetting(SETTING_KEY, JSON.stringify(policy));
    }

    /**
     * Decide whether this ride state warrants a push, and at what severity.
     *
     * Pure, so the decision is testable without a push provider — the part
     * that goes wrong in notification systems is the policy, not the transport.
     */
    static decide(
        policy: NotificationPolicy,
        opts: { isNewRequest: boolean; triggers: AttentionTrigger[]; severity: AttentionSeverity },
    ): { notify: boolean; urgent: boolean; reason: NotificationTrigger | null } {
        if (!policy.pushEnabled) return { notify: false, urgent: false, reason: null };

        // An attention trigger outranks "new request": if a ride is already in
        // trouble, that is the more useful thing to say about it.
        for (const t of opts.triggers) {
            if (policy.triggers.includes(t as NotificationTrigger)) {
                return {
                    notify: true,
                    urgent: policy.urgentTriggers.includes(t as NotificationTrigger) || opts.severity === 'urgent',
                    reason: t as NotificationTrigger,
                };
            }
        }

        if (opts.isNewRequest && policy.triggers.includes('EVERY_REQUEST')) {
            return { notify: true, urgent: false, reason: 'EVERY_REQUEST' };
        }
        return { notify: false, urgent: false, reason: null };
    }

    /**
     * Push to on-duty Operations staff. Never throws — a notification failure
     * must not affect the ride or the queue.
     */
    static async notify(row: QueueRow, opts: { isNewRequest: boolean }): Promise<void> {
        try {
            const config = loadOperationsDispatchConfig();
            if (!config.enabled) return;

            const policy = await this.policy();
            const decision = this.decide(policy, {
                isNewRequest: opts.isNewRequest,
                triggers: row.attention.triggers,
                severity: row.attention.severity,
            });
            if (!decision.notify) return;

            // Deduped per ride per reason, so a ride sitting in NEEDS ATTENTION
            // for four minutes does not buzz every poll.
            const key = `${row.rideId}:${decision.reason}`;
            const last = this.recentlyNotified.get(key) ?? 0;
            const now = Date.now();
            if (now - last < policy.dedupeWindowSeconds * 1000) return;
            this.recentlyNotified.set(key, now);
            if (this.recentlyNotified.size > 2000) this.recentlyNotified.clear();

            const area = row.pickupArea ?? 'an unrecorded area';
            const title = decision.urgent
                ? `No driver — ${area}`
                : `New request — ${area}`;
            const body = decision.reason === 'EVERY_REQUEST'
                ? `${row.passenger?.name ?? 'A passenger'} · ${area} → ${row.destinationArea ?? 'destination'}`
                : `${this.explain(decision.reason)} · waiting ${Math.round(row.waitingSeconds / 60)}m`;

            await StaffPushService.sendToPermission(
                'ops:queue_read',
                { title, body, urgent: decision.urgent },
                { rideId: row.rideId, reason: decision.reason ?? '', kind: 'ops_queue' },
            );
        } catch (err: any) {
            console.warn(`[OPS_NOTIFY] failed for ${row.rideId}: ${err?.message}`);
        }
    }

    static explain(t: NotificationTrigger | null): string {
        switch (t) {
            case 'NO_ELIGIBLE_DRIVER': return 'No eligible driver nearby';
            case 'NO_DRIVER_ACCEPTED': return 'Offers sent, nobody accepted';
            case 'WAIT_EXCEEDS_THRESHOLD': return 'Passenger waiting a long time';
            case 'TECHNICAL_FAILURE': return 'Dispatch failed technically';
            case 'DISPATCH_EXHAUSTED': return 'Dispatch exhausted';
            case 'EVERY_REQUEST': return 'New ride request';
            default: return 'Ride needs attention';
        }
    }

    /** Testing seam. */
    static resetDedupe(): void {
        this.recentlyNotified.clear();
    }
}
