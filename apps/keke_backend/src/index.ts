import 'reflect-metadata';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import { SocketHandler } from './sockets/socket_handler';
import { AppDataSource } from './config/data_source';
import { Ride } from './models/Ride';
import financeRoutes from './routes/finance_routes';
import adminRoutes from './routes/admin_routes';
import driverRoutes from "./routes/driver_routes";
import authRoutes, { driverAuthRouter } from "./routes/auth_routes";
import rideRoutes from "./routes/ride_routes";
import notificationRoutes from "./routes/notification_routes";
import { NotificationService } from './services/notification_service';
import { redis } from './config/redis';

dotenv.config();

process.on('unhandledRejection', (reason: any) => {
  console.error('[FATAL] Unhandled Promise Rejection:', reason?.message || reason);
});

process.on('uncaughtException', (err: Error) => {
  console.error('[FATAL] Uncaught Exception:', err.message);
  process.exit(1);
});

const _allowedOrigins = process.env.ALLOWED_ORIGINS;
if (!_allowedOrigins) {
  throw new Error('FATAL: ALLOWED_ORIGINS environment variable is not set. Refusing to start.');
}
const ALLOWED_ORIGINS: string[] = _allowedOrigins.split(',').map(o => o.trim());

const app = express();
app.use(helmet());
app.use(cors({ origin: ALLOWED_ORIGINS, credentials: true }));
app.use(express.json({ limit: '1mb' }));

app.use((req, res, next) => {
  const start = Date.now();
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  (req as any).requestId = requestId;
  res.on('finish', () => {
    console.log(JSON.stringify({
      level: res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
      requestId,
      method: req.method,
      url: req.originalUrl,
      status: res.statusCode,
      durationMs: Date.now() - start,
    }));
  });
  next();
});

app.get('/health', async (req, res) => {
  try {
    await AppDataSource.query('SELECT 1');
    await redis.ping();
    res.status(200).json({ status: 'ok', db: 'up', redis: 'up', timestamp: new Date().toISOString() });
  } catch (err: any) {
    res.status(503).json({ status: 'degraded', error: err.message });
  }
});

app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/driver/auth', driverAuthRouter);
app.use('/api/v1/finance', financeRoutes);
app.use('/api/v1/admin', adminRoutes);
app.use('/api/v1/drivers', driverRoutes);
app.use('/api/v1/rides', rideRoutes);
app.use('/api/v1/notifications', notificationRoutes);

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: ALLOWED_ORIGINS, methods: ['GET', 'POST'] },
});

new SocketHandler(io);

const PORT = process.env.PORT || 3000;

app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  const status = err.statusCode || err.status || 500;
  console.error(JSON.stringify({ level: 'error', url: req.originalUrl, error: err.message }));
  res.status(status).json({ error: status < 500 ? err.message : 'Internal Server Error' });
});

AppDataSource.initialize()
  .then(async () => {
    console.log(JSON.stringify({ level: 'info', message: 'PostgreSQL initialized' }));
    NotificationService.initialize();

    // Sweep rides stuck in 'searching' from before last restart
    try {
      const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000);
      const swept = await AppDataSource.getRepository(Ride)
        .createQueryBuilder()
        .update()
        .set({ status: 'failed' as any })
        .where('status = :status AND "createdAt" < :cutoff', { status: 'searching', cutoff: tenMinAgo })
        .execute();
      if (swept.affected && swept.affected > 0) {
        console.log(JSON.stringify({ level: 'info', message: `Swept ${swept.affected} stale searching rides to failed` }));
      }
    } catch (e: any) {
      console.error(JSON.stringify({ level: 'warn', message: 'Stale ride sweep failed', error: e.message }));
    }

    const server = httpServer.listen(PORT, () => {
      console.log(JSON.stringify({ level: 'info', message: `Keke Backend running on port ${PORT}` }));
    });

    const shutdown = async (signal: string) => {
      console.log(JSON.stringify({ level: 'info', message: `${signal} received, shutting down gracefully` }));
      server.close(async () => {
        try {
          await AppDataSource.destroy();
          redis.disconnect();
        } catch (e) {}
        process.exit(0);
      });
      setTimeout(() => process.exit(1), 10000);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  })
  .catch((err) => {
    console.error(JSON.stringify({ level: 'error', message: 'DB init failed', error: err.message }));
    process.exit(1);
  });
