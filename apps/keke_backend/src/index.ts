import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import { SocketHandler } from './sockets/socket_handler';
import { AppDataSource } from './config/data_source';
import financeRoutes from './routes/finance_routes';
import adminRoutes from './routes/admin_routes';
import driverRoutes from './routes/driver_routes';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Main Routes
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

