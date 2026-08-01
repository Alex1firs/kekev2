import { Request, Response } from 'express';
import { AppDataSource } from '../config/data_source';
import { DeviceToken } from '../models/DeviceToken';
import { UserRole } from '../models/User';

export class NotificationController {
    static async registerToken(req: Request, res: Response) {
        // appVersion is optional and absent from every app build released so
        // far. That is deliberate: contact-privacy enforcement treats a device
        // that has never reported a version as an OLD client and keeps the
        // legacy behaviour for it. See config/contact_privacy_config.ts.
        const { token, platform, deviceLabel, role, appVersion } = req.body;
        const userId = (req as any).user?.userId;

        if (!token || !platform || !userId || !role) {
            return res.status(400).json({ error: 'Missing required fields: token, platform, role' });
        }

        try {
            const tokenRepo = AppDataSource.getRepository(DeviceToken);
            
            // Check if this token is already registered (might belong to another user now)
            let deviceToken = await tokenRepo.findOne({ where: { token } });

            if (deviceToken) {
                // Update existing record (transfer ownership if necessary)
                deviceToken.userId = userId;
                deviceToken.role = role as UserRole;
                deviceToken.platform = platform;
                deviceToken.deviceLabel = deviceLabel;
                deviceToken.isActive = true;
                deviceToken.lastSeenAt = new Date();
                if (typeof appVersion === 'string' && appVersion.trim()) {
                    deviceToken.appVersion = appVersion.trim().slice(0, 32);
                }
            } else {
                // Create new record
                deviceToken = tokenRepo.create({
                    userId,
                    token,
                    platform,
                    deviceLabel,
                    role: role as UserRole,
                    isActive: true,
                    lastSeenAt: new Date(),
                    appVersion: (typeof appVersion === 'string' && appVersion.trim())
                        ? appVersion.trim().slice(0, 32)
                        : null,
                });
            }

            await tokenRepo.save(deviceToken);
            console.log(`[TOKEN_REG] Registered ${platform} token for ${role} ${userId}`);
            res.status(200).json({ message: 'Token registered successfully' });
        } catch (error) {
            console.error('[TOKEN_ERROR] Registration failed:', error);
            res.status(500).json({ error: 'Internal server error' });
        }
    }

    static async deactivateToken(req: Request, res: Response) {
        const token = req.params.token as string;
        
        try {
            const tokenRepo = AppDataSource.getRepository(DeviceToken);
            await tokenRepo.update({ token }, { isActive: false });
            console.log(`[TOKEN_DEACT] Deactivated token: ${token.substring(0, 10)}...`);
            res.status(200).json({ message: 'Token deactivated' });
        } catch (error) {
            res.status(500).json({ error: 'Internal server error' });
        }
    }
}
