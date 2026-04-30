import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { DispatchService } from '../services/dispatch_service';
import { NotificationService } from '../services/notification_service';
import { UserRole } from '../models/User';
import { AppDataSource } from '../config/data_source';
import { Ride } from '../models/Ride';
import { DriverProfile } from '../models/DriverProfile';
import { redis } from '../config/redis';
import { WalletService } from '../services/wallet_service';

const _jwtSecret = process.env.JWT_SECRET;
if (!_jwtSecret) {
    throw new Error('FATAL: JWT_SECRET environment variable is not set. Refusing to start.');
}
const JWT_SECRET: string = _jwtSecret;

export class SocketHandler {
  private io: Server;

  // Track rejected drivers per ride to exclude them in expansion
  private rideExclusions: Map<string, Set<string>> = new Map();

  // Track currently ringing drivers to emit immediate cancellation (optimization)
  private activeDispatches: Map<string, Set<string>> = new Map();

  // Track driver to active ride mapping for live location streaming
  private driverRideMap: Map<string, string> = new Map();

  // Centralized audit logger
  private auditLog(rideId: string, event: string, target: string, status?: string) {
    console.log(`[BACKEND_BROADCAST] Ride: ${rideId} | Event: ${event} | Target: ${target} ${status ? `| Status: ${status}` : ''}`);
  }

  private broadcastToRide(rideId: string, event: string, data: any) {
    this.auditLog(rideId, event, `ride:${rideId}`, data.status);
    this.io.to(`ride:${rideId}`).emit(event, data);
  }

  constructor(io: Server) {
    this.io = io;
    this.setupHandlers();
  }

  private setupHandlers() {
    this.io.use((socket, next) => {
      const token = socket.handshake.auth?.token || socket.handshake.query?.token as string;
      if (!token) {
        return next(new Error('Authentication required'));
      }
      try {
        const decoded = jwt.verify(token, JWT_SECRET) as any;
        (socket as any).user = decoded;
        next();
      } catch (err) {
        next(new Error('Invalid or expired token'));
      }
    });

    this.io.on('connection', (socket: Socket) => {
      console.log(`New connection: ${socket.id}`);

      // --- Room Management ---
      socket.on('join', async (data: { userId: string; role: 'passenger' | 'driver' | 'admin' | 'ride' }) => {
        if (data.role === 'driver') {
          try {
            const driverRepo = AppDataSource.getRepository(DriverProfile);
            const profile = await driverRepo.findOneBy({ userId: data.userId });
            if (profile && profile.status === 'suspended') {
              console.warn(`[SOCKET_AUTH] Suspended driver ${data.userId} attempted to join. Disconnecting.`);
              socket.emit('error:suspended', { message: 'Your account is suspended. Contact support.' });
              return socket.disconnect();
            }
          } catch (err) {
            console.error('Failed to verify driver status during join:', err);
          }
        }

        const room = data.role === 'ride' ? `ride:${data.userId}` : `${data.role}:${data.userId}`;
        socket.join(room);
        if (data.role === 'admin') {
          socket.join('admin');
        }
        console.log(`${room} joined`);
      });

      // --- Driver Heartbeat & Location ---
      socket.on('driver:heartbeat', async (data: { driverId: string; lat: number; lng: number }) => {
        // Enforce suspension check on every heartbeat to catch real-time bans
        try {
          const driverRepo = AppDataSource.getRepository(DriverProfile);
          const profile = await driverRepo.findOneBy({ userId: data.driverId });
          if (!profile || profile.status === 'suspended' || profile.status === 'rejected') {
            console.warn(`[SOCKET_BLOCK] Heartbeat rejected for driver ${data.driverId} (Status: ${profile?.status})`);
            socket.emit('error:suspended', { message: 'Operational activity blocked.' });
            return;
          }
        } catch (err) {
          console.error('Heartbeat status check failed:', err);
        }

        await DispatchService.updateDriverLocation(data.driverId, data.lat, data.lng);

        // Stream live location to passenger ONLY if driver is actively assigned a ride
        const activeRideId = this.driverRideMap.get(data.driverId);
        if (activeRideId) {
          this.io.to(`ride:${activeRideId}`).emit('driver:location_update', {
            driverId: data.driverId,
            lat: data.lat,
            lng: data.lng
          });
        }
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
          const rideRepo = AppDataSource.getRepository(Ride);
          const ride = rideRepo.create({
            rideId,
            passengerId,
            fare,
            paymentMode: isCash ? 'cash' : 'wallet',
            status: 'searching' as any,
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
        this.startDispatchLoop(rideId, pickupLat, pickupLng, request).catch((err: any) => {
          console.error(JSON.stringify({ level: 'error', event: 'dispatch_loop_failed', rideId, error: err?.message }));
        });
      });

      // --- Passenger Cancel Ride ---
      socket.on('ride:cancel', async (data: { rideId: string; passengerId: string }) => {
        try {
          const rideRepo = AppDataSource.getRepository(Ride);
          const ride = await rideRepo.findOne({ where: { rideId: data.rideId } });

          if (!ride) {
            return socket.emit('ride:error', { message: 'Ride not found' });
          }

          // Auth-safe: Verify passenger owns the ride
          if (ride.passengerId !== data.passengerId) {
            return socket.emit('ride:error', { message: 'Unauthorized cancellation attempt' });
          }

          // Verify ride is still in cancellable state
          if (ride.status === 'searching' as any || ride.status === 'accepted' as any || ride.status === 'arrived' as any) {
            await rideRepo.update(data.rideId, { status: 'canceled' as any, completedAt: new Date() });

            this.io.to('admin').emit('ride:status_update', { rideId: data.rideId, status: 'canceled' });
            this.broadcastToRide(data.rideId, 'ride:cancelled', { rideId: data.rideId });

            // If a driver accepted it, stop tracking
            if (ride.driverId) {
              this.driverRideMap.delete(ride.driverId);
            }

            // Immediately dismiss request UI for any ringing/notified drivers (Optimization)
            const notifiedDrivers = this.activeDispatches.get(data.rideId);
            if (notifiedDrivers) {
              console.log(`[BACKEND_DISMISS] Signaling ${notifiedDrivers.size} drivers to dismiss ride ${data.rideId}`);
              for (const driverId of notifiedDrivers) {
                this.io.to(`driver:${driverId}`).emit('ride:cancelled', { rideId: data.rideId });
                // PUSH: Dismiss/Cancel Request for Driver
                NotificationService.sendToUser(driverId, UserRole.DRIVER, 'Ride Cancelled', 'The request has been cancelled.', {
                  type: 'RIDE_CANCELLED',
                  rideId: data.rideId,
                  intent: 'home'
                });
              }
            }

            // PUSH: Cancel for Passenger (Authoritative)
            NotificationService.sendToUser(data.passengerId, UserRole.PASSENGER, 'Ride Cancelled', 'Your ride has been cancelled.', {
              type: 'RIDE_CANCELLED',
              rideId: data.rideId,
              intent: 'home'
            });

            // Clean memory Maps
            this.rideExclusions.delete(data.rideId);
            this.activeDispatches.delete(data.rideId);

            console.log(`Ride ${data.rideId} successfully canceled by passenger ${data.passengerId}.`);
          } else {
            socket.emit('ride:error', { message: 'Ride cannot be canceled at this stage' });
          }
        } catch (err) {
          console.error('Failed to cancel ride:', err);
        }
      });

      // --- Driver Accept ---
      socket.on('ride:accept', async (data: { rideId: string; driverId: string; driverDetails: any }) => {
        try {
          const driverRepo = AppDataSource.getRepository(DriverProfile);
          const profile = await driverRepo.findOneBy({ userId: data.driverId });
          if (!profile || profile.status === 'suspended' || profile.status === 'rejected') {
            console.warn(`[SOCKET_BLOCK] Ride acceptance blocked for driver ${data.driverId} (Status: ${profile?.status})`);
            socket.emit('error:suspended', { message: 'Operational activity blocked.' });
            return;
          }

          const locked = await DispatchService.acquireRideLock(data.rideId, data.driverId);

          if (locked) {
            let currentRide: any = null;
            // Update Ride status in Postgres
            try {
              const rideRepo = AppDataSource.getRepository(Ride);

              // Critical Check: is ride cancelled in the DB?
              currentRide = await rideRepo.findOne({ where: { rideId: data.rideId } });
              if (!currentRide || currentRide.status === 'canceled') {
                // Too late, passenger just canceled. Clear lock and inform driver.
                await redis.del(`ride:${data.rideId}:lock`);
                return socket.emit('ride:cancelled', { rideId: data.rideId });
              }

              await rideRepo.update(data.rideId, {
                driverId: data.driverId,
                status: 'accepted' as any
              });
            } catch (err) {
              console.error('Failed to update ride to accepted:', err);
            }

            // Link mapping for Live Location Streaming
            this.driverRideMap.set(data.driverId, data.rideId);

            // Build driverDetails from real DB profile, not client payload
            const realProfile = profile;
            const driverDetails = {
              name: `${realProfile.firstName} ${realProfile.lastName}`,
              vehiclePlate: realProfile.vehiclePlate,
              vehicleModel: realProfile.vehicleModel,
            };

            this.broadcastToRide(data.rideId, 'ride:assigned', {
              driverId: data.driverId,
              driverDetails: driverDetails
            });

            // PUSH: Assigned for Passenger
            NotificationService.sendToUser(currentRide.passengerId, UserRole.PASSENGER, 'Driver Assigned!', 'A driver is on the way to you.', {
              type: 'RIDE_ASSIGNED',
              rideId: data.rideId,
              intent: 'active'
            });
            socket.emit('ride:confirmed', { rideId: data.rideId });
            this.io.to('admin').emit('ride:status_update', { rideId: data.rideId, status: 'accepted' });

            this.rideExclusions.delete(data.rideId);
            this.activeDispatches.delete(data.rideId); // Cleanup
          } else {
            socket.emit('ride:expired', { rideId: data.rideId, message: 'Already accepted by another driver' });
          }
        } catch (err) {
          console.error('ride:accept status check failed:', err);
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
          const ride = await this.validateRideState(data.rideId, ['accepted']);
          if (!ride) return;

          const rideRepo = AppDataSource.getRepository(Ride);
          await rideRepo.update(data.rideId, { status: 'arrived' as any });

          this.broadcastToRide(data.rideId, 'ride:status_update', { rideId: data.rideId, status: 'arrived' });

          // PUSH: Arrived for Passenger
          NotificationService.sendToUser(ride.passengerId, UserRole.PASSENGER, 'Driver Arrived!', 'Your driver has reached the pickup location.', {
            type: 'RIDE_ARRIVED',
            rideId: data.rideId,
            intent: 'active'
          });
          this.io.to('admin').emit('ride:status_update', { rideId: data.rideId, status: 'arrived' });
        } catch (err) {
          console.error('Failed to update ride to arrived:', err);
        }
      });

      // --- Trip Started ---
      socket.on('ride:start', async (data: { rideId: string; driverId: string }) => {
        try {
          const ride = await this.validateRideState(data.rideId, ['arrived', 'accepted']);
          if (!ride) return;

          const rideRepo = AppDataSource.getRepository(Ride);
          await rideRepo.update(data.rideId, { status: 'in_progress' as any });

          this.broadcastToRide(data.rideId, 'ride:status_update', { rideId: data.rideId, status: 'in_progress' });

          // PUSH: Started for Passenger
          NotificationService.sendToUser(ride.passengerId, UserRole.PASSENGER, 'Trip Started', 'You are now on your trip.', {
            type: 'TRIP_STARTED',
            rideId: data.rideId,
            intent: 'active'
          });
          this.io.to('admin').emit('ride:status_update', { rideId: data.rideId, status: 'in_progress' });
        } catch (err) {
          console.error('Failed to update ride to in_progress:', err);
        }
      });

      // --- Ride Completion ---
      socket.on('ride:complete', async (data: {
        rideId: string;
        passengerId: string;
        driverId: string;
      }) => {
        try {
          const ride = await this.validateRideState(data.rideId, ['in_progress', 'started']);
          if (!ride) return;

          // Essential Cleanup (Unlink driver from ride for tracking)
          this.driverRideMap.delete(data.driverId);

          // Read fare and paymentMode from DB, not socket payload
          const fareToCharge = Number(ride.fare);
          const isCashPayment = ride.paymentMode === 'cash';

          // Attempt financial posting
          console.log(`Processing financials for completed ride ${data.rideId}`);
          await WalletService.postRideFinancials({
            rideId: data.rideId,
            passengerId: ride.passengerId,
            driverId: ride.driverId,
            totalFare: fareToCharge,
            isCash: isCashPayment,
          }).catch(async (e: any) => {
            console.error(JSON.stringify({ level: 'error', event: 'payment_failed', rideId: data.rideId, error: e.message }));
            const rideRepo = AppDataSource.getRepository(Ride);
            await rideRepo.update(data.rideId, { paymentFailed: true } as any).catch(() => {});
          });

          // Update Ride status in Postgres
          const rideRepo = AppDataSource.getRepository(Ride);
          await rideRepo.update(data.rideId, {
            status: 'completed' as any,
            completedAt: new Date()
          });

          this.io.to('admin').emit('ride:status_update', { rideId: data.rideId, status: 'completed' });
          this.broadcastToRide(data.rideId, 'ride:finished', { rideId: data.rideId });

          // PUSH: Completed for Passenger
          NotificationService.sendToUser(data.passengerId, UserRole.PASSENGER, 'Trip Completed', 'Hope you enjoyed the ride!', {
            type: 'TRIP_COMPLETED',
            rideId: data.rideId,
            intent: 'receipt'
          });
        } catch (err) {
          console.error('Ride completion lifecycle failed:', err);
        }
      });
    });
  }

  private async startDispatchLoop(rideId: string, lat: number, lng: number, payload: any) {
    const radiuses = [3, 5]; // 3km then 5km
    this.activeDispatches.set(rideId, new Set());

    for (const radius of radiuses) {
      // Postgres source of truth check: halt loop instantly if cancelled
      const rideRepo = AppDataSource.getRepository(Ride);
      const dbRide = await rideRepo.findOne({ where: { rideId } });
      if (!dbRide || dbRide.status === 'canceled' as any) {
        this.activeDispatches.delete(rideId);
        return;
      }

      // Check if ride is already assigned (via Redis lock)
      const isAssigned = await this.isRideAssigned(rideId);
      if (isAssigned) {
        this.activeDispatches.delete(rideId);
        return;
      }

      console.log(`Searching in ${radius}km radius for ride ${rideId}`);
      this.io.to(`ride:${rideId}`).emit('ride:searching', { radius });

      const nearbyDrivers = await DispatchService.findNearbyDrivers(lat, lng, radius);
      const exclusions = this.rideExclusions.get(rideId) || new Set();

      const targetDrivers = nearbyDrivers.filter(id => !exclusions.has(id));

      if (targetDrivers.length > 0) {
        const notifiedSet = this.activeDispatches.get(rideId) || new Set();
        targetDrivers.forEach(driverId => {
          notifiedSet.add(driverId);
          this.io.to(`driver:${driverId}`).emit('ride:request', payload);

          // PUSH: New Ride Request for Driver
          NotificationService.sendToUser(driverId, UserRole.DRIVER, 'New Ride Request', 'You have a new request nearby!', {
            type: 'NEW_REQUEST',
            rideId: payload.rideId,
            intent: 'booking'
          });
        });
        this.activeDispatches.set(rideId, notifiedSet);

        // Wait for 15s for acceptance before expanding radius
        await new Promise(resolve => setTimeout(resolve, 15000));
      } else {
        // No drivers in this radius, immediately try expansion or wait short time
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    }

    // Final check after expansion
    const finalRepo = AppDataSource.getRepository(Ride);
    const finalRide = await finalRepo.findOne({ where: { rideId } });
    if (finalRide && finalRide.status !== 'canceled' as any && !await this.isRideAssigned(rideId)) {
      this.io.to(`ride:${rideId}`).emit('ride:failed', { message: 'No drivers available nearby' });
      this.rideExclusions.delete(rideId);
      this.activeDispatches.delete(rideId);
    }
  }

  private async isRideAssigned(rideId: string): Promise<boolean> {
    // A pure read check. We do NOT acquire the lock here, otherwise drivers are blocked from accepting.
    const lockVal = await redis.get(`ride:${rideId}:lock`);
    return lockVal !== null && lockVal !== 'probe';
  }

  private async validateRideState(rideId: string, allowedStatuses: string[]): Promise<any> {
    const rideRepo = AppDataSource.getRepository(Ride);
    const ride = await rideRepo.findOne({ where: { rideId } });

    if (!ride || !allowedStatuses.includes(ride.status)) {
      console.warn(`[SYNC_AUDIT] Ignored action for ride ${rideId} - illegal state transition from ${ride?.status}`);
      return null;
    }

    // Operational Guard: Check driver status if driver is assigned
    if (ride.driverId) {
      const driverRepo = AppDataSource.getRepository(DriverProfile);
      const profile = await driverRepo.findOneBy({ userId: ride.driverId });
      if (profile && (profile.status === 'suspended' || profile.status === 'rejected')) {
        console.error(`[SYNC_AUDIT] Blocked action for ride ${rideId} - driver ${ride.driverId} is ${profile.status}`);
        return null;
      }
    }

    return ride;
  }
}
