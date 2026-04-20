import { Server, Socket } from 'socket.io';
import { DispatchService } from '../services/dispatch_service';

export class SocketHandler {
  private io: Server;
  
  // Track rejected drivers per ride to exclude them in expansion
  private rideExclusions: Map<string, Set<string>> = new Map();

  constructor(io: Server) {
    this.io = io;
    this.setupHandlers();
  }

  private setupHandlers() {
    this.io.on('connection', (socket: Socket) => {
      console.log(`New connection: ${socket.id}`);

      // --- Room Management ---
      socket.on('join', (data: { userId: string; role: 'passenger' | 'driver' | 'admin' }) => {
        socket.join(`${data.role}:${data.userId}`);
        if (data.role === 'admin') {
          socket.join('admin');
        }
        console.log(`${data.role}:${data.userId} joined room`);
      });

      // --- Driver Heartbeat & Location ---
      socket.on('driver:heartbeat', async (data: { driverId: string; lat: number; lng: number }) => {
        await DispatchService.updateDriverLocation(data.driverId, data.lat, data.lng);
      });

      // --- Driver Offline Toggle ---
      socket.on('driver:offline', async (data: { driverId: string }) => {
        await DispatchService.removeDriverAvailability(data.driverId);
        console.log(`Driver ${data.driverId} went offline`);
      });

      // --- Passenger Ride Request ---
      socket.on('ride:request', async (request: any) => {
        const { rideId, pickupLat, pickupLng, passengerId, fare, isCash, pickupAddress, destinationAddress } = request;
        
        // 1. Persist initial Ride record
        try {
          const rideRepo = require('../config/data_source').AppDataSource.getRepository(require('../models').Ride);
          const ride = rideRepo.create({
            rideId,
            passengerId,
            fare,
            paymentMode: isCash ? 'cash' : 'wallet',
            status: 'searching',
            pickupAddress,
            destinationAddress,
            pickupLat,
            pickupLng
          });
          await rideRepo.save(ride);
        } catch (err) {
          console.error('Failed to persist ride record:', err);
        }

        this.rideExclusions.set(rideId, new Set());
        console.log(`Starting dispatch for ride ${rideId}`);
        this.io.to('admin').emit('ride:status_update', { rideId, status: 'searching' });
        this.startDispatchLoop(rideId, pickupLat, pickupLng, request);
      });

      // --- Driver Accept ---
      socket.on('ride:accept', async (data: { rideId: string; driverId: string; driverDetails: any }) => {
        const locked = await DispatchService.acquireRideLock(data.rideId, data.driverId);
        
        if (locked) {
          // Update Ride status in Postgres
          try {
            const rideRepo = require('../config/data_source').AppDataSource.getRepository(require('../models').Ride);
            await rideRepo.update(data.rideId, { 
              driverId: data.driverId, 
              status: 'accepted' as any 
            });
          } catch (err) {
             console.error('Failed to update ride to accepted:', err);
          }

          this.io.to(`passenger:${data.rideId}`).emit('ride:assigned', {
            driverId: data.driverId,
            driverDetails: data.driverDetails
          });
          socket.emit('ride:confirmed', { rideId: data.rideId });
          this.io.to('admin').emit('ride:status_update', { rideId: data.rideId, status: 'accepted' });
          
          this.rideExclusions.delete(data.rideId);
        } else {
          socket.emit('ride:expired', { rideId: data.rideId, message: 'Already accepted by another driver' });
        }
      });

      // --- Driver Reject ---
      socket.on('ride:reject', (data: { rideId: string; driverId: string }) => {
        const exclusions = this.rideExclusions.get(data.rideId);
        if (exclusions) {
          exclusions.add(data.driverId);
        }
      });

      // --- Driver Arrived ---
      socket.on('ride:arrived', async (data: { rideId: string; driverId: string }) => {
        try {
          const rideRepo = require('../config/data_source').AppDataSource.getRepository(require('../models').Ride);
          await rideRepo.update(data.rideId, { status: 'arrived' as any });
        } catch (err) {
          console.error('Failed to update ride to arrived:', err);
        }
        this.io.to(`passenger:${data.rideId}`).emit('ride:status_update', { rideId: data.rideId, status: 'arrived' });
        this.io.to('admin').emit('ride:status_update', { rideId: data.rideId, status: 'arrived' });
      });

      // --- Trip Started ---
      socket.on('ride:start', async (data: { rideId: string; driverId: string }) => {
        try {
          const rideRepo = require('../config/data_source').AppDataSource.getRepository(require('../models').Ride);
          await rideRepo.update(data.rideId, { status: 'in_progress' as any });
        } catch (err) {
          console.error('Failed to update ride to in_progress:', err);
        }
        this.io.to(`passenger:${data.rideId}`).emit('ride:status_update', { rideId: data.rideId, status: 'started' });
        this.io.to('admin').emit('ride:status_update', { rideId: data.rideId, status: 'in_progress' });
      });

      // --- Ride Completion ---
      socket.on('ride:complete', async (data: { 
        rideId: string; 
        passengerId: string; 
        driverId: string; 
        totalFare: number; 
        isCash: boolean; 
      }) => {
        try {
          console.log(`Processing financials for completed ride ${data.rideId}`);
          await require('../services/wallet_service').WalletService.postRideFinancials(data);
          
          // Update Ride status in Postgres
          const rideRepo = require('../config/data_source').AppDataSource.getRepository(require('../models').Ride);
          await rideRepo.update(data.rideId, { 
            status: 'completed' as any,
            completedAt: new Date()
          });

          this.io.to('admin').emit('ride:status_update', { rideId: data.rideId, status: 'completed' });
          this.io.to(`passenger:${data.passengerId}`).emit('ride:finished', { rideId: data.rideId });
        } catch (err) {
          console.error('Financial posting failed:', err);
        }
      });
    });
  }

  private async startDispatchLoop(rideId: string, lat: number, lng: number, payload: any) {
    const radiuses = [3, 5]; // 3km then 5km
    
    for (const radius of radiuses) {
      // Check if ride is already assigned (via Redis lock)
      const isAssigned = await this.isRideAssigned(rideId);
      if (isAssigned) return;

      console.log(`Searching in ${radius}km radius for ride ${rideId}`);
      this.io.to(`passenger:${rideId}`).emit('ride:searching', { radius });

      const nearbyDrivers = await DispatchService.findNearbyDrivers(lat, lng, radius);
      const exclusions = this.rideExclusions.get(rideId) || new Set();

      const targetDrivers = nearbyDrivers.filter(id => !exclusions.has(id));

      if (targetDrivers.length > 0) {
        targetDrivers.forEach(driverId => {
          this.io.to(`driver:${driverId}`).emit('ride:request', payload);
        });
        
        // Wait for 15s for acceptance before expanding radius
        await new Promise(resolve => setTimeout(resolve, 15000));
      } else {
        // No drivers in this radius, immediately try expansion or wait short time
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    }

    // Final check after expansion
    if (!await this.isRideAssigned(rideId)) {
      this.io.to(`passenger:${rideId}`).emit('ride:failed', { message: 'No drivers available nearby' });
      this.rideExclusions.delete(rideId);
    }
  }

  private async isRideAssigned(rideId: string): Promise<boolean> {
     // A pure read check. We do NOT acquire the lock here, otherwise drivers are blocked from accepting.
     const lockVal = await require('../config/redis').redis.get(`ride:${rideId}:lock`);
     return lockVal !== null && lockVal !== 'probe';
  }
}
