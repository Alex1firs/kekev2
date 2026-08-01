import * as admin from 'firebase-admin';
import { In, Not } from 'typeorm';
import { AppDataSource } from '../config/data_source';
import {
    StaffDeviceToken, StaffDevicePlatform, StaffTokenStatus,
} from '../models/StaffDeviceToken';
import {
    StaffPushDelivery, PushDeliveryState, PushReason,
} from '../models/StaffPushDelivery';
import { NotificationService } from './notification_service';
import { AuditService, AuditActor } from './audit_service';
import { AppError, ErrorCode } from '../utils/errors';

/**
 * Push for the dispatcher PWA.
 *
 * Sends through the SAME Firebase project and Admin SDK the mobile apps use —
 * only the token store differs. See docs/dispatcher_web_push_audit.md.
 *
 * ── What this can and cannot promise ────────────────────────────────────
 * It can put a notification on a locked screen while the browser process is
 * alive. It cannot survive an OEM battery manager killing Chrome, cannot play a
 * custom sound, and cannot create a high-importance Android channel. Those are
 * platform limits, documented in the audit, and the setup screen tells the
 * dispatcher the truth about them rather than implying a pager.
 */

/** The public web configuration a browser needs. None of this is secret. */
export interface FirebaseWebConfig {
    apiKey: string;
    authDomain: string;
    projectId: string;
    messagingSenderId: string;
    appId: string;
    vapidPublicKey: string;
}

export interface RegisterTokenInput {
    staffUserId: string;
    token: string;
    parkId?: string | null;
    shiftId?: string | null;
    deviceId?: string | null;
    deviceLabel?: string | null;
    userAgent?: string | null;
    platform?: StaffDevicePlatform;
}

export class StaffPushService {
    private static get tokens() { return AppDataSource.getRepository(StaffDeviceToken); }
    private static get deliveries() { return AppDataSource.getRepository(StaffPushDelivery); }

    // ═══════════════════════════════════════════════════════════════════
    //  Configuration
    // ═══════════════════════════════════════════════════════════════════

    /**
     * The browser-side Firebase config, from the environment.
     *
     * Returned to an AUTHENTICATED STAFF SESSION rather than baked into a
     * committed file. Not because these values are secret — they are public
     * identifiers by design — but because a deployment that has not been
     * configured should say so once, clearly, instead of shipping a file full
     * of placeholders that fails mysteriously in a browser.
     */
    static webConfig(): FirebaseWebConfig | null {
        const cfg = {
            apiKey: process.env.FIREBASE_WEB_API_KEY,
            authDomain: process.env.FIREBASE_WEB_AUTH_DOMAIN,
            projectId: process.env.FIREBASE_WEB_PROJECT_ID,
            messagingSenderId: process.env.FIREBASE_WEB_MESSAGING_SENDER_ID,
            appId: process.env.FIREBASE_WEB_APP_ID,
            vapidPublicKey: process.env.FIREBASE_VAPID_PUBLIC_KEY,
        };
        const missing = Object.entries(cfg).filter(([, v]) => !v).map(([k]) => k);
        if (missing.length) return null;
        return cfg as FirebaseWebConfig;
    }

    /** Which configuration values are absent, for the diagnostics screen. */
    static missingConfig(): string[] {
        const names: Record<string, string | undefined> = {
            FIREBASE_WEB_API_KEY: process.env.FIREBASE_WEB_API_KEY,
            FIREBASE_WEB_AUTH_DOMAIN: process.env.FIREBASE_WEB_AUTH_DOMAIN,
            FIREBASE_WEB_PROJECT_ID: process.env.FIREBASE_WEB_PROJECT_ID,
            FIREBASE_WEB_MESSAGING_SENDER_ID: process.env.FIREBASE_WEB_MESSAGING_SENDER_ID,
            FIREBASE_WEB_APP_ID: process.env.FIREBASE_WEB_APP_ID,
            FIREBASE_VAPID_PUBLIC_KEY: process.env.FIREBASE_VAPID_PUBLIC_KEY,
        };
        return Object.entries(names).filter(([, v]) => !v).map(([k]) => k);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Registration
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Register or refresh a dispatcher's push token.
     *
     * Idempotent per token. If the token already exists under ANOTHER staff
     * member the row is reassigned: the same browser cannot be two people at
     * once, and a device handed from one dispatcher to the next must stop
     * alerting the previous one.
     */
    static async register(input: RegisterTokenInput): Promise<StaffDeviceToken> {
        const token = String(input.token ?? '').trim();
        if (token.length < 20) {
            throw new AppError(400, ErrorCode.VALIDATION_ERROR, 'That does not look like a push token.');
        }

        const existing = await this.tokens.findOne({ where: { token } });

        /*
         * Same browser, different person — a park tablet handed over.
         *
         * The token is globally unique (one browser, one token), so the row is
         * REASSIGNED rather than duplicated. An earlier version tried to revoke
         * the old row and insert a new one with the same token, which the
         * unique index correctly refused.
         *
         * What matters operationally is that the previous dispatcher stops
         * being alerted, and reassignment achieves that: the row now belongs to
         * whoever is holding the device. The handover itself stays visible in
         * the delivery history, which is keyed on staff and keeps its rows.
         */
        const handedOverFrom = existing && existing.staffUserId !== input.staffUserId
            ? existing.staffUserId
            : null;

        /*
         * One live token per (staff, device). A browser that rotates its token
         * would otherwise accumulate rows and get several copies of every
         * alert.
         */
        if (input.deviceId) {
            await this.tokens.createQueryBuilder()
                .update()
                .set({
                    status: StaffTokenStatus.REVOKED,
                    revokedReason: 'replaced by a newer token on the same device',
                    revokedAt: new Date(),
                })
                .where('"staffUserId" = :staffUserId', { staffUserId: input.staffUserId })
                .andWhere('"deviceId" = :deviceId', { deviceId: input.deviceId })
                .andWhere('token != :token', { token })
                .andWhere('status = :active', { active: StaffTokenStatus.ACTIVE })
                .execute();
        }

        const row = existing ?? this.tokens.create({ token });

        row.staffUserId = input.staffUserId;
        row.platform = input.platform ?? StaffDevicePlatform.WEB;
        row.status = StaffTokenStatus.ACTIVE;
        row.parkId = input.parkId ?? null;
        row.shiftId = input.shiftId ?? null;
        row.deviceId = input.deviceId ?? null;
        row.deviceLabel = input.deviceLabel?.slice(0, 120) ?? row.deviceLabel ?? null;
        row.userAgent = input.userAgent?.slice(0, 300) ?? null;
        row.lastSeenAt = new Date();
        row.revokedReason = handedOverFrom
            ? `taken over from staff ${handedOverFrom}`
            : null;
        row.revokedAt = null;

        // A handover resets the park binding: the new holder gets whatever
        // their own shift says, never the previous dispatcher's park.
        if (handedOverFrom) {
            row.parkId = input.parkId ?? null;
            row.shiftId = input.shiftId ?? null;
            row.lastPushAcceptedAt = null;
            row.lastPushReceivedAt = null;
            row.lastNotificationOpenedAt = null;
        }

        return this.tokens.save(row);
    }

    /** Every live device for one staff member. */
    static activeForStaff(staffUserId: string): Promise<StaffDeviceToken[]> {
        return this.tokens.find({
            where: { staffUserId, status: StaffTokenStatus.ACTIVE },
            order: { lastSeenAt: 'DESC' },
        });
    }

    /**
     * Revoke tokens.
     *
     * Called on sign-out, shift close, staff suspension and device
     * replacement. Deliberately keeps the row: a deleted token tells you
     * nothing later, and "why did this dispatcher stop being alerted" is a
     * question somebody eventually asks.
     */
    static async revoke(
        args: { staffUserId: string; token?: string; deviceId?: string; reason: string },
    ): Promise<number> {
        const qb = this.tokens.createQueryBuilder()
            .update()
            .set({
                status: StaffTokenStatus.REVOKED,
                revokedReason: args.reason.slice(0, 200),
                revokedAt: new Date(),
            })
            .where('"staffUserId" = :staffUserId', { staffUserId: args.staffUserId })
            .andWhere('status = :active', { active: StaffTokenStatus.ACTIVE });

        if (args.token) qb.andWhere('token = :token', { token: args.token });
        if (args.deviceId) qb.andWhere('"deviceId" = :deviceId', { deviceId: args.deviceId });

        const result = await qb.execute();
        return result.affected ?? 0;
    }

    /** Bind a staff member's live devices to the park they just opened a shift at. */
    static async bindToShift(staffUserId: string, parkId: string, shiftId: string): Promise<void> {
        await this.tokens.update(
            { staffUserId, status: StaffTokenStatus.ACTIVE },
            { parkId, shiftId, lastSeenAt: new Date() },
        );
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Sending
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Alert every on-shift dispatcher at a park about a job.
     *
     * Addressed by PARK, not by person: a request arrives at a park, and
     * whoever is on duty there should hear about it.
     */
    static async notifyParkDispatchers(args: {
        parkId: string;
        jobId: string;
        rideId: string;
        title: string;
        body: string;
        reason?: PushReason;
        /** Extra data for the service worker. Must contain nothing sensitive. */
        data?: Record<string, string>;
    }): Promise<{ tokens: number; accepted: number; failed: number }> {
        const reason = args.reason ?? PushReason.NEW_REQUEST;

        const devices = await this.tokens.find({
            where: { parkId: args.parkId, status: StaffTokenStatus.ACTIVE },
        });

        if (devices.length === 0) {
            await this.record({
                staffUserId: 'NONE', parkId: args.parkId, jobId: args.jobId, rideId: args.rideId,
                reason, state: PushDeliveryState.UNKNOWN,
                detail: { note: 'no registered dispatcher device at this park' },
            });
            return { tokens: 0, accepted: 0, failed: 0 };
        }

        NotificationService.initialize();
        if (!NotificationService.isReady()) {
            for (const d of devices) {
                await this.record({
                    staffUserId: d.staffUserId, parkId: args.parkId, jobId: args.jobId, rideId: args.rideId,
                    staffDeviceTokenId: d.id, tokenRef: this.tokenRef(d.token),
                    reason, state: PushDeliveryState.UNKNOWN,
                    detail: { note: 'push is not configured on this deployment' },
                });
            }
            return { tokens: devices.length, accepted: 0, failed: devices.length };
        }

        /*
         * `tag` deduplicates on the DEVICE: a reminder for the same job replaces
         * the first notification rather than stacking a second one on the lock
         * screen. `renotify` makes the replacement alert again anyway, which is
         * the whole point of a reminder.
         */
        const tag = `park-job-${args.jobId}`;

        const message: admin.messaging.MulticastMessage = {
            tokens: devices.map((d) => d.token),
            notification: { title: args.title, body: args.body },
            data: {
                type: 'PARK_DISPATCH_JOB',
                jobId: args.jobId,
                rideId: args.rideId,
                parkId: args.parkId,
                reason,
                ...(args.data ?? {}),
            },
            webpush: {
                headers: {
                    // Ask the browser to hold it for 5 minutes if the device is
                    // offline. Past that the request is likely gone anyway, and
                    // a stale alert is worse than none.
                    TTL: '300',
                    Urgency: 'high',
                },
                notification: {
                    title: args.title,
                    body: args.body,
                    tag,
                    renotify: true,
                    requireInteraction: true,
                    icon: '/dispatch/icons/icon-192.png',
                    badge: '/dispatch/icons/icon-192.png',
                    // Honoured on most Android builds. There is no web API for
                    // a custom SOUND — the OS default tone plays. See the audit.
                    vibrate: [200, 100, 200, 100, 200],
                },
                fcmOptions: {
                    // Where a tap lands when the service worker is not running.
                    link: `/dispatch/index.html?job=${encodeURIComponent(args.jobId)}`,
                },
            },
        };

        let accepted = 0; let failed = 0;
        try {
            const response = await admin.messaging().sendEachForMulticast(message);
            const invalid: string[] = [];

            for (let i = 0; i < response.responses.length; i++) {
                const r = response.responses[i];
                const device = devices[i];

                if (r.success) {
                    accepted++;
                    await this.record({
                        staffUserId: device.staffUserId, parkId: args.parkId,
                        jobId: args.jobId, rideId: args.rideId,
                        staffDeviceTokenId: device.id, tokenRef: this.tokenRef(device.token),
                        reason,
                        // ACCEPTED, not delivered. The distinction is the point.
                        state: PushDeliveryState.PROVIDER_ACCEPTED,
                        providerRef: r.messageId ?? null,
                    });
                    device.lastPushAcceptedAt = new Date();
                    await this.tokens.save(device);
                } else {
                    failed++;
                    const code = r.error?.code ?? 'unknown';
                    const gone = code === 'messaging/invalid-registration-token'
                        || code === 'messaging/registration-token-not-registered';
                    if (gone) invalid.push(device.token);

                    await this.record({
                        staffUserId: device.staffUserId, parkId: args.parkId,
                        jobId: args.jobId, rideId: args.rideId,
                        staffDeviceTokenId: device.id, tokenRef: this.tokenRef(device.token),
                        reason,
                        state: gone ? PushDeliveryState.TOKEN_INVALID : PushDeliveryState.FAILED,
                        providerRef: code,
                        detail: { message: r.error?.message ?? null },
                    });
                }
            }

            if (invalid.length) {
                await this.tokens.update(
                    { token: In(invalid) },
                    {
                        status: StaffTokenStatus.INVALID,
                        revokedReason: 'FCM reported the token no longer exists',
                        revokedAt: new Date(),
                    },
                );
            }
        } catch (err: any) {
            for (const d of devices) {
                await this.record({
                    staffUserId: d.staffUserId, parkId: args.parkId, jobId: args.jobId, rideId: args.rideId,
                    staffDeviceTokenId: d.id, tokenRef: this.tokenRef(d.token),
                    reason, state: PushDeliveryState.FAILED,
                    detail: { error: err?.message ?? 'send threw' },
                });
            }
            failed = devices.length;
        }

        return { tokens: devices.length, accepted, failed };
    }

    /** A single test push to one device, from the setup screen. */
    static async sendTest(staffUserId: string, tokenId: string): Promise<{ accepted: boolean; detail: string }> {
        const device = await this.tokens.findOne({ where: { id: tokenId, staffUserId } });
        if (!device) throw new AppError(404, ErrorCode.NOT_FOUND, 'That device is not registered to you.');
        if (device.status !== StaffTokenStatus.ACTIVE) {
            return { accepted: false, detail: `This device is ${device.status}. Re-enable notifications and try again.` };
        }

        NotificationService.initialize();
        if (!NotificationService.isReady()) {
            return { accepted: false, detail: 'Push is not configured on this server.' };
        }

        try {
            const messageId = await admin.messaging().send({
                token: device.token,
                notification: {
                    title: 'KekeRide test alert',
                    body: 'If you can see and hear this, your device is set up correctly.',
                },
                data: { type: 'DISPATCHER_TEST' },
                webpush: {
                    headers: { TTL: '60', Urgency: 'high' },
                    notification: {
                        title: 'KekeRide test alert',
                        body: 'If you can see and hear this, your device is set up correctly.',
                        tag: 'dispatcher-test',
                        renotify: true,
                        icon: '/dispatch/icons/icon-192.png',
                        vibrate: [200, 100, 200],
                    },
                },
            });

            await this.record({
                staffUserId, parkId: device.parkId, jobId: null, rideId: null,
                staffDeviceTokenId: device.id, tokenRef: this.tokenRef(device.token),
                reason: PushReason.TEST, state: PushDeliveryState.PROVIDER_ACCEPTED,
                providerRef: messageId,
            });

            return {
                accepted: true,
                // Careful wording: acceptance is not arrival.
                detail: 'Sent. It should arrive within a few seconds — if nothing appears, notifications are blocked somewhere on the device.',
            };
        } catch (err: any) {
            await this.record({
                staffUserId, parkId: device.parkId, jobId: null, rideId: null,
                staffDeviceTokenId: device.id, tokenRef: this.tokenRef(device.token),
                reason: PushReason.TEST, state: PushDeliveryState.FAILED,
                providerRef: err?.code ?? null, detail: { message: err?.message },
            });
            return { accepted: false, detail: err?.message ?? 'The push could not be sent.' };
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Acknowledgements from the device
    // ═══════════════════════════════════════════════════════════════════

    /**
     * The service worker ran its handler, or a human opened the notification.
     *
     * Only ever ADVANCES the state — a late "received" must not overwrite an
     * "opened" that already happened.
     */
    static async acknowledge(args: {
        staffUserId: string;
        jobId?: string | null;
        token?: string | null;
        state: PushDeliveryState.SERVICE_WORKER_RECEIVED
            | PushDeliveryState.NOTIFICATION_OPENED
            | PushDeliveryState.REQUEST_VIEWED;
    }): Promise<void> {
        const now = new Date();

        const RANK: Record<string, number> = {
            [PushDeliveryState.QUEUED]: 0,
            [PushDeliveryState.PROVIDER_ACCEPTED]: 1,
            [PushDeliveryState.SERVICE_WORKER_RECEIVED]: 2,
            [PushDeliveryState.NOTIFICATION_OPENED]: 3,
            [PushDeliveryState.REQUEST_VIEWED]: 4,
        };

        const row = await this.deliveries.findOne({
            where: {
                staffUserId: args.staffUserId,
                ...(args.jobId ? { jobId: args.jobId } : {}),
            },
            order: { createdAt: 'DESC' },
        });

        if (row && (RANK[args.state] ?? 0) > (RANK[row.state] ?? 0)) {
            row.state = args.state;
            if (args.state === PushDeliveryState.SERVICE_WORKER_RECEIVED) row.receivedAt = now;
            if (args.state === PushDeliveryState.NOTIFICATION_OPENED) row.openedAt = now;
            await this.deliveries.save(row);
        }

        // Keep the device row current too, so the diagnostics screen can show
        // "last alert received" without scanning the delivery table.
        if (args.token) {
            const patch: Partial<StaffDeviceToken> = { lastSeenAt: now };
            if (args.state === PushDeliveryState.SERVICE_WORKER_RECEIVED) patch.lastPushReceivedAt = now;
            if (args.state === PushDeliveryState.NOTIFICATION_OPENED) patch.lastNotificationOpenedAt = now;
            await this.tokens.update({ token: args.token, staffUserId: args.staffUserId }, patch);
        }
    }

    /** What the diagnostics screen shows about recent delivery. */
    static async recentFor(staffUserId: string, limit = 20): Promise<StaffPushDelivery[]> {
        return this.deliveries.find({
            where: { staffUserId },
            order: { createdAt: 'DESC' },
            take: limit,
        });
    }

    /** Deliveries for one job, for the operations view. */
    static async forJob(jobId: string): Promise<StaffPushDelivery[]> {
        return this.deliveries.find({ where: { jobId }, order: { createdAt: 'ASC' } });
    }

    // ═══════════════════════════════════════════════════════════════════

    /**
     * The last 12 characters of a token.
     *
     * Enough to match a delivery to a device in a support conversation, useless
     * to anyone who obtains the log. The whole token is a sending credential.
     */
    private static tokenRef(token: string): string {
        return token.length <= 12 ? token : `…${token.slice(-12)}`;
    }

    private static async record(input: {
        staffUserId: string;
        parkId?: string | null;
        jobId?: string | null;
        rideId?: string | null;
        staffDeviceTokenId?: string | null;
        tokenRef?: string | null;
        reason: PushReason;
        state: PushDeliveryState;
        providerRef?: string | null;
        detail?: Record<string, unknown> | null;
    }): Promise<void> {
        try {
            await this.deliveries.save(this.deliveries.create({
                staffUserId: input.staffUserId,
                parkId: input.parkId ?? null,
                jobId: input.jobId ?? null,
                rideId: input.rideId ?? null,
                staffDeviceTokenId: input.staffDeviceTokenId ?? null,
                tokenRef: input.tokenRef ?? null,
                reason: input.reason,
                state: input.state,
                providerRef: input.providerRef ?? null,
                detail: input.detail ?? null,
            }));
        } catch (err: any) {
            // Evidence is important but must never stop an alert going out.
            console.error(JSON.stringify({
                level: 'error', event: 'staff_push_evidence_failed', error: err?.message,
            }));
        }
    }
}

/** Suspending or deactivating a staff account must silence their devices. */
export async function revokeTokensForSuspendedStaff(
    staffUserId: string, actor: AuditActor, reason: string,
): Promise<void> {
    const n = await StaffPushService.revoke({ staffUserId, reason });
    if (n > 0) {
        await AuditService.record({
            actor,
            action: 'STAFF_PUSH_REVOKED',
            resourceType: 'STAFF_DEVICE_TOKEN',
            resourceId: staffUserId,
            reason,
            metadata: { revoked: n },
        }).catch(() => { /* the revocation stands regardless */ });
    }
}

export { Not };
