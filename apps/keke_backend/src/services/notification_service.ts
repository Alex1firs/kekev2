import * as admin from 'firebase-admin';
import { AppDataSource } from '../config/data_source';
import { DeviceToken } from '../models/DeviceToken';
import { UserRole } from '../models/User';
import { In } from 'typeorm';
import { redis } from '../config/redis';
import path from 'path';
import fs from 'fs';

export class NotificationService {
    private static initialized = false;

    static initialize() {
        if (this.initialized) return;

        const serviceAccountPath = path.join(__dirname, '../config/firebase-admin.json');
        
        if (fs.existsSync(serviceAccountPath)) {
            const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });
            this.initialized = true;
            console.log('[NOTIFICATION_SERVICE] Firebase Admin initialized.');
        } else {
            console.warn('[NOTIFICATION_SERVICE] Missing firebase-admin.json. Notifications will be logged to console only.');
        }
    }

    /**
     * Send push notification to all active devices of a user
     */
    static async sendToUser(userId: string, role: UserRole, title: string, body: string, data: any = {}) {
        if (!this.initialized) this.initialize();

        const tokenRepo = AppDataSource.getRepository(DeviceToken);
        const activeTokens = await tokenRepo.find({
            where: { userId, role, isActive: true }
        });

        if (activeTokens.length === 0) {
            console.log(`[NOTIFICATION_LOG] No active tokens for user ${userId} (${role})`);
            return;
        }

        const tokens = activeTokens.map(t => t.token);

        // 2-second dedup window — prevents double-pushes when multiple events fire close together
        const rideId = data?.rideId;
        const type: string = data?.type || '';
        if (rideId && type) {
            const dedupKey = `notif:${userId}:${type}:${rideId}`;
            const already = await redis.get(dedupKey);
            if (already) return;
            await redis.setex(dedupKey, 2, '1');
        }

        console.log(`[NOTIFICATION_SEND] To ${userId} | Title: ${title} | Body: ${body} | Tokens: ${tokens.length}`);

        if (!this.initialized) return;

        const customSoundTypes = ['NEW_REQUEST', 'RIDE_ASSIGNED', 'RIDE_ARRIVED'];
        const sound = customSoundTypes.includes(type) ? 'keke_ring.wav' : 'default';

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
                notification: {
                    sound: sound.replace('.wav', ''), // Android uses filename without extension
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

        try {
            const response = await admin.messaging().sendEachForMulticast(message);
            console.log(`[NOTIFICATION_RESULT] Success: ${response.successCount} | Failure: ${response.failureCount}`);
            
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
        } catch (error) {
            console.error('[NOTIFICATION_ERROR] Failed to send multicast message:', error);
        }
    }
}
