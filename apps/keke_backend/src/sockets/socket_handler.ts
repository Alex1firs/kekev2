import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
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

// In production/staging suppress info logs; always keep warn/error
const IS_PROD = process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging';
const log = {
    info: IS_PROD ? (_msg: any, ..._rest: any[]) => {} : (...args: any[]) => console.log(...args),
    warn: (...args: any[]) => console.warn(...args),
    error: (...args: any[]) => console.error(...args),
};

// Nigeria bounding box for coordinate validation
const LAT_MIN = 4.0, LAT_MAX = 14.0;
const LNG_MIN = 2.0, LNG_MAX = 15.0;
const lat = () => z.number().min(LAT_MIN).max(LAT_MAX);
const lng = () => z.number().min(LNG_MIN).max(LNG_MAX);
const id  = () => z.string().min(1).max(128);

const Schemas = {
    join: z.object({
        userId: id(),
        role: z.enum(['passenger', 'driver', 'admin', 'ride']),
    }),
    heartbeat: z.object({
        driverId: id(),
        lat: lat(),
        lng: lng(),
    }),
    driverOffline: z.object({ driverId: id() }),
    rideRequest: z.object({
        rideId:             id(),
        passengerId:        id(),
        fare:               z.number().min(100).max(50000),
        isCash:             z.boolean(),
        pickupLat:          lat(),
        pickupLng:          lng(),
        destinationLat:     lat().optional(),
        destinationLng:     lng().optional(),
        pickupAddress:      z.string().max(300).optional(),
        destinationAddress: z.string().max(300).optional(),
    }),
    rideCancel:       z.object({ rideId: id(), passengerId: id() }),
    rideAccept:       z.object({ rideId: id(), driverId: id() }),
    rideDriverAction: z.object({ rideId: id(), driverId: id() }),
    rideComplete:     z.object({ rideId: id(), passengerId: id(), driverId: id() }),
};

function validate<T>(schema: z.ZodSchema<T>, data: unknown, socket: Socket): T | null {
    const result = schema.safeParse(data);
    if (!result.success) {
        socket.emit('ride:error', { message: 'Invalid request data' });
        return null;
    }
    return result.data;
}

export class SocketHandler {
    private io: Server;
    private rideExclusions:   Map<string, Set<string>> = new Map();
    private activeDispatches: Map<string, Set<string>> = new Map();
    private driverRideMap:    Map<string, string>       = new Map();

    private broadcastToRide(rideId: string, event: string, data: any) {
        log.info(`[BROADCAST] Ride:${rideId} Event:${event}`);
        this.io.to(`ride:${rideId}`).emit(event, data);
    }

    constructor(io: Server) {
        this.io = io;
        this.setupHandlers();
    }

    private setupHandlers() {
        this.io.use((socket, next) => {
            const token = socket.handshake.auth?.token || socket.handshake.query?.token as string;
            if (!token) return next(new Error('Authentication required'));
            try {
                const decoded = jwt.verify(token, JWT_SECRET) as any;
                (socket as any).user = decoded;
                next();
            } catch {
                next(new Error('Invalid or expired token'));
            }
        });

        this.io.on('connection', (socket: Socket) => {
            log.info(`New connection: ${socket.id}`);

            // --- Room Management ---
            socket.on('join', async (raw) => {
                const data = validate(Schemas.join, raw, socket);
                if (!data) return;

                if (data.role === 'driver') {
                    try {
                        const profile = await AppDataSource.getRepository(DriverProfile).findOneBy({ userId: data.userId });
                        if (profile?.status === 'suspended') {
                            log.warn(`[SOCKET_AUTH] Suspended driver ${data.userId} attempted to join.`);
                            socket.emit('error:suspended', { message: 'Your account is suspended. Contact support.' });
                            return socket.disconnect();
                        }
                    } catch (err) {
                        log.error('Failed to verify driver status during join:', err);
                    }
                }

                const room = data.role === 'ride' ? `ride:${data.userId}` : `${data.role}:${data.userId}`;
                socket.join(room);
                if (data.role === 'admin') socket.join('admin');
                log.info(`${room} joined`);
            });

            // --- Driver Heartbeat & Location ---
            socket.on('driver:heartbeat', async (raw) => {
                const data = validate(Schemas.heartbeat, raw, socket);
                if (!data) return;

                try {
                    const profile = await AppDataSource.getRepository(DriverProfile).findOneBy({ userId: data.driverId });
                    if (!profile || profile.status === 'suspended' || profile.status === 'rejected') {
                        log.warn(`[SOCKET_BLOCK] Heartbeat rejected for driver ${data.driverId} (Status: ${profile?.status})`);
                        socket.emit('error:suspended', { message: 'Operational activity blocked.' });
                        return;
                    }
                } catch (err) {
                    log.error('Heartbeat status check failed:', err);
                }

                await DispatchService.updateDriverLocation(data.driverId, data.lat, data.lng);

                const activeRideId = this.driverRideMap.get(data.driverId);
                if (activeRideId) {
                    this.io.to(`ride:${activeRideId}`).emit('driver:location_update', {
                        driverId: data.driverId, lat: data.lat, lng: data.lng,
                    });
                }
            });

            // --- Driver Offline Toggle ---
            socket.on('driver:offline', async (raw) => {
                const data = validate(Schemas.driverOffline, raw, socket);
                if (!data) return;
                await DispatchService.removeDriverAvailability(data.driverId);
                log.info(`Driver ${data.driverId} went offline`);
            });

            // --- Passenger Ride Request ---
            socket.on('ride:request', async (raw) => {
                const request = validate(Schemas.rideRequest, raw, socket);
                if (!request) return;

                const { rideId, pickupLat, pickupLng, passengerId, fare, isCash, pickupAddress, destinationAddress } = request;

                try {
                    const rideRepo = AppDataSource.getRepository(Ride);
                    const ride = rideRepo.create({
                        rideId, passengerId, fare,
                        paymentMode: isCash ? 'cash' : 'wallet',
                        status: 'searching' as any,
                        pickupAddress, destinationAddress, pickupLat, pickupLng,
                    });
                    await rideRepo.save(ride);
                } catch (err) {
                    log.error('Failed to persist ride record:', err);
                    socket.emit('ride:error', { message: 'Failed to create ride. Please try again.' });
                    return;
                }

                this.rideExclusions.set(rideId, new Set());
                log.info(`Starting dispatch for ride ${rideId}`);
                this.io.to('admin').emit('ride:status_update', { rideId, status: 'searching' });
                this.startDispatchLoop(rideId, pickupLat, pickupLng, request).catch((err: any) => {
                    log.error(JSON.stringify({ level: 'error', event: 'dispatch_loop_failed', rideId, error: err?.message }));
                });
            });

            // --- Passenger Cancel Ride ---
            socket.on('ride:cancel', async (raw) => {
                const data = validate(Schemas.rideCancel, raw, socket);
                if (!data) return;
                try {
                    const rideRepo = AppDataSource.getRepository(Ride);
                    const ride = await rideRepo.findOne({ where: { rideId: data.rideId } });

                    if (!ride) return socket.emit('ride:error', { message: 'Ride not found' });
                    if (ride.passengerId !== data.passengerId) return socket.emit('ride:error', { message: 'Unauthorized cancellation attempt' });

                    const cancellable = ['searching', 'accepted', 'arrived'] as any[];
                    if (!cancellable.includes(ride.status)) {
                        return socket.emit('ride:error', { message: 'Ride cannot be canceled at this stage' });
                    }

                    await rideRepo.update(data.rideId, { status: 'canceled' as any, completedAt: new Date() });
                    this.io.to('admin').emit('ride:status_update', { rideId: data.rideId, status: 'canceled' });
                    this.broadcastToRide(data.rideId, 'ride:cancelled', { rideId: data.rideId });

                    if (ride.driverId) this.driverRideMap.delete(ride.driverId);

                    const notifiedDrivers = this.activeDispatches.get(data.rideId);
                    if (notifiedDrivers) {
                        log.info(`[BACKEND_DISMISS] Signaling ${notifiedDrivers.size} drivers to dismiss ride ${data.rideId}`);
                        for (const driverId of notifiedDrivers) {
                            this.io.to(`driver:${driverId}`).emit('ride:cancelled', { rideId: data.rideId });
                            NotificationService.sendToUser(driverId, UserRole.DRIVER, 'Ride Cancelled', 'The request has been cancelled.', {
                                type: 'RIDE_CANCELLED', rideId: data.rideId, intent: 'home',
                            });
                        }
                    }

                    NotificationService.sendToUser(data.passengerId, UserRole.PASSENGER, 'Ride Cancelled', 'Your ride has been cancelled.', {
                        type: 'RIDE_CANCELLED', rideId: data.rideId, intent: 'home',
                    });

                    this.rideExclusions.delete(data.rideId);
                    this.activeDispatches.delete(data.rideId);
                    log.info(`Ride ${data.rideId} canceled by passenger ${data.passengerId}`);
                } catch (err) {
                    log.error('Failed to cancel ride:', err);
                }
            });

            // --- Driver Accept ---
            socket.on('ride:accept', async (raw) => {
                const data = validate(Schemas.rideAccept, raw, socket);
                if (!data) return;
                try {
                    const profile = await AppDataSource.getRepository(DriverProfile).findOneBy({ userId: data.driverId });
                    if (!profile || profile.status === 'suspended' || profile.status === 'rejected') {
                        log.warn(`[SOCKET_BLOCK] Ride acceptance blocked for driver ${data.driverId} (Status: ${profile?.status})`);
                        socket.emit('error:suspended', { message: 'Operational activity blocked.' });
                        return;
                    }

                    // Atomic UPDATE: claims the ride only if still 'searching'.
                    // PostgreSQL row-level locking makes this race-condition-free —
                    // no two drivers can both get affected=1 for the same row.
                    const rideRepo = AppDataSource.getRepository(Ride);
                    const updateResult = await rideRepo
                        .createQueryBuilder()
                        .update()
                        .set({ driverId: data.driverId, status: 'accepted' as any })
                        .where('"rideId" = :rideId AND status = :status', { rideId: data.rideId, status: 'searching' })
                        .returning('*')
                        .execute();

                    if (!updateResult.affected || updateResult.affected === 0) {
                        socket.emit('ride:expired', { rideId: data.rideId, message: 'Ride already taken or cancelled' });
                        return;
                    }

                    const currentRide = updateResult.raw[0];

                    // Signal the dispatch loop to stop polling
                    await redis.set(`ride:${data.rideId}:lock`, data.driverId);

                    this.driverRideMap.set(data.driverId, data.rideId);

                    const driverDetails = {
                        name: `${profile.firstName} ${profile.lastName}`,
                        vehiclePlate: profile.vehiclePlate,
                        vehicleModel: profile.vehicleModel,
                    };

                    this.broadcastToRide(data.rideId, 'ride:assigned', { driverId: data.driverId, driverDetails });

                    NotificationService.sendToUser(currentRide.passengerId || currentRide.passengerId, UserRole.PASSENGER, 'Driver Assigned!', 'A driver is on the way to you.', {
                        type: 'RIDE_ASSIGNED', rideId: data.rideId, intent: 'active',
                    });
                    socket.emit('ride:confirmed', { rideId: data.rideId });
                    this.io.to('admin').emit('ride:status_update', { rideId: data.rideId, status: 'accepted' });

                    this.rideExclusions.delete(data.rideId);
                    this.activeDispatches.delete(data.rideId);
                } catch (err) {
                    log.error('ride:accept failed:', err);
                }
            });

            // --- Driver Reject ---
            socket.on('ride:reject', (raw) => {
                const data = validate(Schemas.rideDriverAction, raw, socket);
                if (!data) return;
                this.rideExclusions.get(data.rideId)?.add(data.driverId);
            });

            // --- Driver Arrived ---
            socket.on('ride:arrived', async (raw) => {
                const data = validate(Schemas.rideDriverAction, raw, socket);
                if (!data) return;
                try {
                    const ride = await this.validateRideState(data.rideId, ['accepted']);
                    if (!ride) return;
                    await AppDataSource.getRepository(Ride).update(data.rideId, { status: 'arrived' as any });
                    this.broadcastToRide(data.rideId, 'ride:status_update', { rideId: data.rideId, status: 'arrived' });
                    NotificationService.sendToUser(ride.passengerId, UserRole.PASSENGER, 'Driver Arrived!', 'Your driver has reached the pickup location.', {
                        type: 'RIDE_ARRIVED', rideId: data.rideId, intent: 'active',
                    });
                    this.io.to('admin').emit('ride:status_update', { rideId: data.rideId, status: 'arrived' });
                } catch (err) {
                    log.error('Failed to update ride to arrived:', err);
                }
            });

            // --- Trip Started ---
            socket.on('ride:start', async (raw) => {
                const data = validate(Schemas.rideDriverAction, raw, socket);
                if (!data) return;
                try {
                    const ride = await this.validateRideState(data.rideId, ['arrived', 'accepted']);
                    if (!ride) return;
                    await AppDataSource.getRepository(Ride).update(data.rideId, { status: 'in_progress' as any });
                    this.broadcastToRide(data.rideId, 'ride:status_update', { rideId: data.rideId, status: 'in_progress' });
                    NotificationService.sendToUser(ride.passengerId, UserRole.PASSENGER, 'Trip Started', 'You are now on your trip.', {
                        type: 'TRIP_STARTED', rideId: data.rideId, intent: 'active',
                    });
                    this.io.to('admin').emit('ride:status_update', { rideId: data.rideId, status: 'in_progress' });
                } catch (err) {
                    log.error('Failed to update ride to in_progress:', err);
                }
            });

            // --- Ride Completion ---
            socket.on('ride:complete', async (raw) => {
                const data = validate(Schemas.rideComplete, raw, socket);
                if (!data) return;
                try {
                    const ride = await this.validateRideState(data.rideId, ['in_progress', 'started']);
                    if (!ride) return;

                    this.driverRideMap.delete(data.driverId);

                    const fareToCharge = Number(ride.fare);
                    const isCashPayment = ride.paymentMode === 'cash';

                    log.info(`Processing financials for completed ride ${data.rideId}`);

                    let paymentSucceeded = false;
                    try {
                        await WalletService.postRideFinancials({
                            rideId: data.rideId,
                            passengerId: ride.passengerId,
                            driverId: ride.driverId,
                            totalFare: fareToCharge,
                            isCash: isCashPayment,
                        });
                        paymentSucceeded = true;
                    } catch (e: any) {
                        log.error(JSON.stringify({ level: 'error', event: 'payment_failed', rideId: data.rideId, error: e.message }));
                        const rideRepo = AppDataSource.getRepository(Ride);
                        await rideRepo.update(data.rideId, { paymentFailed: true } as any);
                        // Alert admin so they can manually resolve
                        this.io.to('admin').emit('ride:payment_failed', { rideId: data.rideId, error: e.message });
                        socket.emit('ride:payment_error', {
                            rideId: data.rideId,
                            message: 'Payment processing failed. Our team will resolve this shortly.',
                        });
                    }

                    // Do not mark ride completed if payment failed — keeps audit trail clean
                    if (!paymentSucceeded) return;

                    const rideRepo = AppDataSource.getRepository(Ride);
                    await rideRepo.update(data.rideId, { status: 'completed' as any, completedAt: new Date() });

                    this.io.to('admin').emit('ride:status_update', { rideId: data.rideId, status: 'completed' });
                    this.broadcastToRide(data.rideId, 'ride:finished', { rideId: data.rideId });

                    NotificationService.sendToUser(data.passengerId, UserRole.PASSENGER, 'Trip Completed', 'Hope you enjoyed the ride!', {
                        type: 'TRIP_COMPLETED', rideId: data.rideId, intent: 'receipt',
                    });
                } catch (err) {
                    log.error('Ride completion lifecycle failed:', err);
                }
            });
        });
    }

    private async startDispatchLoop(rideId: string, lat: number, lng: number, payload: any) {
        const radiuses = [3, 5];
        this.activeDispatches.set(rideId, new Set());

        for (const radius of radiuses) {
            const rideRepo = AppDataSource.getRepository(Ride);
            const dbRide = await rideRepo.findOne({ where: { rideId } });
            if (!dbRide || dbRide.status === 'canceled' as any) {
                this.activeDispatches.delete(rideId);
                return;
            }
            if (await this.isRideAssigned(rideId)) {
                this.activeDispatches.delete(rideId);
                return;
            }

            log.info(`Searching in ${radius}km radius for ride ${rideId}`);
            this.io.to(`ride:${rideId}`).emit('ride:searching', { radius });

            const nearbyDrivers = await DispatchService.findNearbyDrivers(lat, lng, radius);
            const exclusions = this.rideExclusions.get(rideId) || new Set();
            const targetDrivers = nearbyDrivers.filter(id => !exclusions.has(id));

            if (targetDrivers.length > 0) {
                const notifiedSet = this.activeDispatches.get(rideId) || new Set();
                for (const driverId of targetDrivers) {
                    notifiedSet.add(driverId);
                    this.io.to(`driver:${driverId}`).emit('ride:request', payload);
                    NotificationService.sendToUser(driverId, UserRole.DRIVER, 'New Ride Request', 'You have a new request nearby!', {
                        type: 'NEW_REQUEST', rideId: payload.rideId, intent: 'booking',
                    });
                }
                this.activeDispatches.set(rideId, notifiedSet);
                await new Promise(resolve => setTimeout(resolve, 15000));
            } else {
                await new Promise(resolve => setTimeout(resolve, 3000));
            }
        }

        // Dispatch exhausted all tiers — mark ride as failed and clean up
        const finalRepo = AppDataSource.getRepository(Ride);
        const finalRide = await finalRepo.findOne({ where: { rideId } });
        if (finalRide && finalRide.status !== 'canceled' as any && !await this.isRideAssigned(rideId)) {
            await finalRepo.update(rideId, { status: 'failed' as any });
            this.io.to(`ride:${rideId}`).emit('ride:failed', { message: 'No drivers available nearby' });
            this.rideExclusions.delete(rideId);
            this.activeDispatches.delete(rideId);
        }
    }

    private async isRideAssigned(rideId: string): Promise<boolean> {
        const lockVal = await redis.get(`ride:${rideId}:lock`);
        return lockVal !== null && lockVal !== 'probe';
    }

    private async validateRideState(rideId: string, allowedStatuses: string[]): Promise<any> {
        const rideRepo = AppDataSource.getRepository(Ride);
        const ride = await rideRepo.findOne({ where: { rideId } });

        if (!ride || !allowedStatuses.includes(ride.status)) {
            log.warn(`[SYNC_AUDIT] Ignored action for ride ${rideId} - illegal state transition from ${ride?.status}`);
            return null;
        }

        if (ride.driverId) {
            const profile = await AppDataSource.getRepository(DriverProfile).findOneBy({ userId: ride.driverId });
            if (profile && (profile.status === 'suspended' || profile.status === 'rejected')) {
                log.error(`[SYNC_AUDIT] Blocked action for ride ${rideId} - driver ${ride.driverId} is ${profile.status}`);
                return null;
            }
        }

        return ride;
    }
}
