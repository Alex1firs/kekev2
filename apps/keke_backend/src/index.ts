import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import { SocketHandler } from './sockets/socket_handler';
import { AppDataSource } from './config/data_source';
import financeRoutes from './routes/finance_routes';
import adminRoutes from './routes/admin_routes';
import driverRoutes from "./routes/driver_routes";
import authRoutes, { driverAuthRouter } from "./routes/auth_routes";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Request logging middleware for production debugging
app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
        const duration = Date.now() - start;
        console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${duration}ms`);
    });
    next();
});
// Healthcheck endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Main Routes
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/driver/auth', driverAuthRouter);
app.use('/api/v1/finance', financeRoutes);
app.use('/api/v1/admin', adminRoutes);
app.use('/api/v1/drivers', driverRoutes);

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

new SocketHandler(io);

const PORT = process.env.PORT || 3000;

// Global Error Handler
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (err instanceof Error) {
    return res.status(400).json({ error: err.message });
  }
  res.status(500).json({ error: "Internal Server Error" });
});

// Initialize Database then Start Server
AppDataSource.initialize()
  .then(() => {
    console.log('PostgreSQL (TypeORM) Initialized');
    httpServer.listen(PORT, () => {
      console.log(`Keke Backend running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Error during Data Source initialization', err);
  });

