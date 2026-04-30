import { Router } from 'express';
import { NotificationController } from '../controllers/notification_controller';
import { authMiddleware } from '../middleware/auth_middleware';

const router = Router();

// Register or update fcm token
router.post('/tokens', authMiddleware, NotificationController.registerToken);

// Deactivate token on logout — no auth required; token value itself is the identifier.
// A caller must know the exact FCM token string to deactivate it (low-risk endpoint).
router.delete('/tokens/:token', NotificationController.deactivateToken);

export default router;
