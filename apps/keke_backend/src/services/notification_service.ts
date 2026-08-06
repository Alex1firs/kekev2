import * as admin from 'firebase-admin';
import { AppDataSource } from '../config/data_source';
import { DeviceToken } from '../models/DeviceToken';
import { UserRole } from '../models/User';
import { In } from 'typeorm';
import { redis } from '../config/redis';
import path from 'path';
import fs from 'fs';
import { OperationalPushHealth } from "./operational_push_health";

/**
 * What actually happened to a push. Dispatch needs this to tell a delivered
 * offer apart from one that silently went nowhere — the old void return made
 * every send look equally successful.
 */
export interface PushResult {
    /** A send was attempted (there was at least one active token and Firebase was up). */
    attempted: boolean;
    /** Active device tokens found for the user. */
    tokenCount: number;
    /** Tokens Firebase accepted. */
    successCount: number;
    /** Tokens Firebase rejected. */
    failureCount: number;
    /** Present when nothing was attempted, or the multicast threw. */
    reason?: 'no_active_tokens' | 'push_disabled' | 'deduplicated' | 'send_failed';
}

export class NotificationService {
    private static initialized = false;

    static initialize() {
        if (this.initialized) return;

        // Prefer env var (base64-encoded JSON) — set FIREBASE_SERVICE_ACCOUNT_JSON in production
        if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
            try {
                const serviceAccount = JSON.parse(
                    Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_JSON, 'base64').toString('utf8')
                );
                admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
                this.initialized = true;
                console.log(`[NOTIFICATION_SERVICE] Firebase initialized from env var (project: ${serviceAccount.project_id}). Push ENABLED.`);
                return;
            } catch (e) {
                console.error('[NOTIFICATION_SERVICE] Failed to parse FIREBASE_SERVICE_ACCOUNT_JSON env var');
            }
        }

        // Fall back to file (development only — do NOT commit firebase-admin.json to production repos)
        const serviceAccountPath = path.join(__dirname, '../config/firebase-admin.json');
        if (fs.existsSync(serviceAccountPath)) {
            const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));
            admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
            this.initialized = true;
            console.log(`[NOTIFICATION_SERVICE] Firebase initialized from file (project: ${serviceAccount.project_id}). Push ENABLED.`);
        } else {
            console.warn('[NOTIFICATION_SERVICE] No Firebase credentials found. Push notifications DISABLED.');
        }
    }

    /**
     * Is Firebase actually configured?
     *
     * Callers need to tell "we tried and it failed" apart from "this deployment
     * has no credentials", and the difference matters: one is an incident, the
     * other is a setup step nobody did. Push was silently off in production for
     * weeks because nothing asked this question.
     */
    static isReady(): boolean {
        if (!this.initialized) this.initialize();
        return this.initialized;
    }

    /**
     * Send a push to all active devices of a user.
     *
     * Returns a [[PushResult]] describing what happened. Existing callers ignore
     * the return value and are unaffected; dispatch uses it as delivery evidence.
     */
    static async sendToUser(userId: string, role: UserRole, title: string, body: string, data: any = {}): Promise<PushResult> {
        if (!this.initialized) this.initialize();

        const tokenRepo = AppDataSource.getRepository(DeviceToken);
        const activeTokens = await tokenRepo.find({
            where: { userId, role, isActive: true }
        });

        if (activeTokens.length === 0) {
            console.log(`[NOTIFICATION_LOG] No active tokens for user ${userId} (${role})`);
            return { attempted: false, tokenCount: 0, successCount: 0, failureCount: 0, reason: 'no_active_tokens' };
        }

        const tokens = activeTokens.map(t => t.token);

        // 2-second dedup window — prevents double-pushes when multiple events fire close together
        const rideId = data?.rideId;
        const type: string = data?.type || '';
        if (rideId && type) {
            const dedupKey = `notif:${userId}:${type}:${rideId}`;
            const already = await redis.get(dedupKey);
            if (already) {
                return { attempted: false, tokenCount: tokens.length, successCount: 0, failureCount: 0, reason: 'deduplicated' };
            }
            await redis.setex(dedupKey, 2, '1');
        }

        console.log(`[NOTIFICATION_SEND] To ${userId} | Title: ${title} | Body: ${body} | Tokens: ${tokens.length}`);

        if (!this.initialized) {
            return { attempted: false, tokenCount: tokens.length, successCount: 0, failureCount: 0, reason: 'push_disabled' };
        }

        const customSoundTypes = ['NEW_REQUEST', 'RIDE_ASSIGNED', 'RIDE_ARRIVED'];
        const sound = customSoundTypes.includes(type) ? 'keke_ring.wav' : 'default';

        // On Android 8+ the ring is owned by the notification CHANNEL, so we must
        // target the right high-importance channel per app. NEW_REQUEST is a
        // driver push (keke_ride_requests); RIDE_ASSIGNED / RIDE_ARRIVED are
        // passenger pushes (keke_ride_updates). Anything else falls back to each
        // app's default_notification_channel_id.
        let androidChannelId: string | undefined;
        if (type === 'NEW_REQUEST') androidChannelId = 'keke_ride_requests';
        else if (type === 'RIDE_ASSIGNED' || type === 'RIDE_ARRIVED') androidChannelId = 'keke_ride_updates';

        const message: admin.messaging.MulticastMessage = {
            tokens: tokens,
            notification: {
                title,
                body,
            },
            data: {
                ...data,
                click_action: 'FLUTTER_NOTIFICATION_CLICK',
            },
            android: {
                priority: 'high',
                notification: {
                    sound: sound.replace('.wav', ''), // Android <8 uses this; 8+ takes the sound from the channel
                    // Route ride alerts to each app's high-importance channel so
                    // the custom ring actually plays on Android 8+ (channel-owned
                    // sound). Other types fall back to the app default channel.
                    channelId: androidChannelId,
                }
            },
            apns: {
                payload: {
                    aps: {
                        sound: sound,
                        badge: 1,
                    },
                },
            },
        };

        // Timed only so the health monitor has a latency sample. Nothing here
        // branches on it.
        const startedAt = Date.now();
        try {
            const response = await admin.messaging().sendEachForMulticast(message);
            console.log(`[NOTIFICATION_RESULT] Success: ${response.successCount} | Failure: ${response.failureCount}`);

            /*
             * Tell the health monitor how that went, so MARKETING push can
             * stand down when operational delivery degrades.
             *
             * Fire-and-forget and cannot throw: `record` swallows everything
             * internally and returns void. This send is a ride alert, an OTP or
             * a payment confirmation — nothing about observing it may delay or
             * fail it, and nothing in this file reads the monitor back.
             */
            OperationalPushHealth.record(
                tokens.length, response.failureCount, Date.now() - startedAt);
            
            // Cleanup invalid tokens
            if (response.failureCount > 0) {
                const invalidTokens: string[] = [];
                response.responses.forEach((resp, idx) => {
                    if (!resp.success) {
                        const errorCode = resp.error?.code;
                        if (errorCode === 'messaging/invalid-registration-token' || 
                            errorCode === 'messaging/registration-token-not-registered') {
                            invalidTokens.push(tokens[idx]);
                        }
                    }
                });

                if (invalidTokens.length > 0) {
                    await tokenRepo.update({ token: In(invalidTokens) }, { isActive: false });
                    console.log(`[NOTIFICATION_CLEANUP] Deactivated ${invalidTokens.length} stale tokens.`);
                }
            }

            return {
                attempted: true,
                tokenCount: tokens.length,
                successCount: response.successCount,
                failureCount: response.failureCount,
            };
        } catch (error) {
            console.error('[NOTIFICATION_ERROR] Failed to send multicast message:', error);
            return {
                attempted: true,
                tokenCount: tokens.length,
                successCount: 0,
                failureCount: tokens.length,
                reason: 'send_failed',
            };
        }
    }
}
