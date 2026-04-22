import { Router } from 'express';
import { NotificationController } from '../controllers/notification_controller';
import { authMiddleware } from '../middleware/auth_middleware';

const router = Router();

// Register or update fcm token
router.post('/tokens', authMiddleware, NotificationController.registerToken);

// Deactivate token on logout
router.delete('/tokens/:token', authMiddleware, NotificationController.deactivateToken);

export default router;
