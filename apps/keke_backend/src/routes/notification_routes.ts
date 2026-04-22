import { Router } from 'express';
import { NotificationController } from '../controllers/notification_controller';
import { authenticate } from '../middleware/auth_middleware';

const router = Router();

// Register or update fcm token
router.post('/tokens', authenticate, NotificationController.registerToken);

// Deactivate token on logout
router.delete('/tokens/:token', authenticate, NotificationController.deactivateToken);

export default router;
