import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { DispatchService } from '../services/dispatch_service';
import { NotificationService } from '../services/notification_service';
import { User, UserRole } from '../models/User';
import { AppDataSource } from '../config/data_source';
import { Ride } from '../models/Ride';
import { DriverProfile } from '../models/DriverProfile';
import { redis } from '../config/redis';
import { WalletService, DEBT_CASH_BLOCK, DEBT_HARD_BLOCK } from '../services/wallet_service';
import { In } from 'typeorm';
import { SosAlert, SosAlertStatus } from '../models/SosAlert';
import {
    RideIntegrityConfig,
    getDriverLiveLocation,
    evaluateProximityGate,
    evaluateCompletion,
    mergeReasons,
    LatLng,
} from '../services/ride_integrity_service';

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
        passengerName:      z.string().max(100).optional(),
        pickupLat:          lat(),
        pickupLng:          lng(),
        destinationLat:     lat().optional(),
        destinationLng:     lng().optional(),
        pickupAddress:      z.string().max(300).optional(),
        destinationAddress: z.string().max(300).optional(),
    }),
    chatMessage: z.object({
        rideId:     id(),
        senderId:   id(),
        senderRole: z.enum(['passenger', 'driver']),
        message:    z.string().min(1).max(500),
    }),
    rideCancel:       z.object({ rideId: id(), passengerId: id() }),
    rideAccept:       z.object({ rideId: id(), driverId: id() }),
    rideDriverAction: z.object({ rideId: id(), driverId: id() }),
    rideComplete:     z.object({
        rideId:          id(),
        passengerId:     id(),
        driverId:        id(),
        totalFare:       z.number().min(100).max(50000).optional(),
        waitTimeSeconds: z.number().int().min(0).optional(),
    }),
    sosAlert: z.object({
        rideId: id(),
        initiatorId: id(),
        initiatorRole: z.enum(['passenger', 'driver']),
        reason: z.string().optional(),
        description: z.string().optional(),
        lat: lat().optional(),
        lng: lng().optional(),
    }),
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
                            socket.emit('error:suspended', { code: 'DRIVER_SUSPENDED', message: 'Your account is suspended. Please contact support.' });
                            return socket.disconnect();
                        }
                    } catch (err) {
                        log.error('Failed to verify driver status during join:', err);
                        socket.emit('ride:error', { code: 'INTERNAL_ERROR', message: 'Could not verify your account status. Please reconnect.' });
                        return;
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
                        socket.emit('error:suspended', { code: 'DRIVER_SUSPENDED', message: 'Your account access is restricted. Please contact support.' });
                        return;
                    }
                } catch (err) {
                    log.error('Heartbeat status check failed:', err);
                    // Non-critical: allow heartbeat to proceed on transient DB errors
                }

                await DispatchService.updateDriverLocation(data.driverId, data.lat, data.lng);

                let activeRideId = this.driverRideMap.get(data.driverId);

                // Recover from server restart: driverRideMap is in-memory and wipes on redeploy.
                // If the map has no entry, look up the active ride from the DB and repopulate.
                if (!activeRideId) {
                    try {
                        const activeRide = await AppDataSource.getRepository(Ride).findOne({
                            where: { driverId: data.driverId, status: In(['accepted', 'arrived', 'in_progress'] as any[]) },
                        });
                        if (activeRide) {
                            activeRideId = activeRide.rideId;
                            this.driverRideMap.set(data.driverId, activeRideId);
                            log.info(`[HEARTBEAT_RECOVERY] Repopulated driverRideMap: ${data.driverId} → ${activeRideId}`);
                        }
                    } catch (err) {
                        log.error('Failed to recover driverRideMap from DB:', err);
                    }
                }

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

                const { rideId, pickupLat, pickupLng, destinationLat, destinationLng, passengerId, fare, isCash, pickupAddress, destinationAddress } = request;

                // 4-character alphanumeric pickup code for passenger/driver verification at boarding
                const pickupCode = Math.random().toString(36).substring(2, 6).toUpperCase();

                try {
                    const rideRepo = AppDataSource.getRepository(Ride);
                    const ride = rideRepo.create({
                        rideId, passengerId, fare,
                        paymentMode: isCash ? 'cash' : 'wallet',
                        status: 'searching' as any,
                        pickupAddress, destinationAddress, pickupLat, pickupLng,
                        destinationLat, destinationLng,
                        pickupCode,
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

                const DISPATCH_TIMEOUT_MS = 40_000;
                Promise.race([
                    this.startDispatchLoop(rideId, pickupLat, pickupLng, request),
                    new Promise<void>((_, reject) =>
                        setTimeout(() => reject(new Error('dispatch_timeout')), DISPATCH_TIMEOUT_MS)
                    ),
                ]).catch(async (err: any) => {
                    log.error(JSON.stringify({ level: 'error', event: 'dispatch_failed', rideId, error: err?.message }));
                    if (err?.message === 'dispatch_timeout') {
                        try {
                            await AppDataSource.getRepository(Ride).update(rideId, { status: 'failed' as any });
                            this.io.to(`ride:${rideId}`).emit('ride:failed', { message: 'No drivers available nearby' });
                            if (passengerId) {
                                NotificationService.sendToUser(passengerId, UserRole.PASSENGER, 'No Driver Found',
                                    "We couldn't find a nearby driver. Please try again.", {
                                    type: 'NO_DRIVER', rideId, intent: 'retry',
                                });
                            }
                        } catch (_) {}
                        this.rideExclusions.delete(rideId);
                        this.activeDispatches.delete(rideId);
                    }
                });
            });

            // --- In-Ride Chat ---
            socket.on('chat:send', (raw) => {
                const data = validate(Schemas.chatMessage, raw, socket);
                if (!data) return;
                // Relay to everyone in the ride room (both passenger and driver are joined)
                this.io.to(`ride:${data.rideId}`).emit('chat:message', {
                    rideId:     data.rideId,
                    senderId:   data.senderId,
                    senderRole: data.senderRole,
                    message:    data.message,
                    timestamp:  new Date().toISOString(),
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

                    // Notify the assigned driver directly (activeDispatches is cleared on accept)
                    if (ride.driverId) {
                        this.driverRideMap.delete(ride.driverId);
                        this.io.to(`driver:${ride.driverId}`).emit('ride:cancelled', { rideId: data.rideId });
                        NotificationService.sendToUser(ride.driverId, UserRole.DRIVER, 'Ride Cancelled', 'The passenger cancelled the ride.', {
                            type: 'RIDE_CANCELLED', rideId: data.rideId, intent: 'home',
                        });
                    }

                    // Dismiss any drivers still in the dispatch queue (searching phase)
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
                    socket.emit('ride:error', { code: 'INTERNAL_ERROR', message: 'Could not cancel the ride right now. Please try again.' });
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
                        socket.emit('error:suspended', { code: 'DRIVER_SUSPENDED', message: 'Your account access is restricted. Please contact support.' });
                        return;
                    }

                    // Debt gate for cash rides
                    const ride = await AppDataSource.getRepository(Ride).findOne({ where: { rideId: data.rideId } });
                    if (ride?.paymentMode === 'cash') {
                        const debt = await WalletService.getDriverDebt(data.driverId);
                        if (debt >= DEBT_CASH_BLOCK) {
                            log.warn(`[DEBT_BLOCK] Cash ride blocked for driver ${data.driverId} — debt ₦${debt}`);
                            socket.emit('error:debt_blocked', {
                                code: 'DEBT_CASH_BLOCKED',
                                message: 'You cannot accept cash rides until your outstanding balance is cleared. Go to your wallet to pay.',
                            });
                            return;
                        }
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
                        socket.emit('ride:expired', { code: 'RIDE_ALREADY_TAKEN', rideId: data.rideId, message: 'This ride is no longer available.' });
                        return;
                    }

                    const currentRide = updateResult.raw[0];

                    // Signal the dispatch loop to stop polling
                    await redis.set(`ride:${data.rideId}:lock`, data.driverId);

                    this.driverRideMap.set(data.driverId, data.rideId);

                    // Anti-fraud evidence: record where the driver was when they
                    // accepted (no gate here — accepting while stationary is normal).
                    try {
                        const acceptLoc = await getDriverLiveLocation(data.driverId);
                        await rideRepo.update(data.rideId, {
                            acceptedAt: new Date(),
                            acceptLat: acceptLoc?.lat ?? null,
                            acceptLng: acceptLoc?.lng ?? null,
                        } as any);
                    } catch (e: any) {
                        log.warn(`[INTEGRITY] accept evidence capture failed for ${data.rideId}: ${e?.message}`);
                    }

                    const driverUser = await AppDataSource.getRepository(User).findOne({ where: { id: data.driverId } });

                    const driverDetails = {
                        name: `${profile.firstName} ${profile.lastName}`,
                        plate: profile.vehiclePlate,
                        model: profile.vehicleModel,
                        phone: driverUser?.phone ?? null,
                        photoUrl: profile.photoUrl ?? null,
                    };

                    this.broadcastToRide(data.rideId, 'ride:assigned', {
                        driverId: data.driverId,
                        driverDetails,
                        pickupCode: ride?.pickupCode ?? null,
                    });

                    NotificationService.sendToUser(currentRide.passengerId || currentRide.passengerId, UserRole.PASSENGER, 'Driver Assigned!', 'A driver is on the way to you.', {
                        type: 'RIDE_ASSIGNED', rideId: data.rideId, intent: 'active',
                    });
                    socket.emit('ride:confirmed', { rideId: data.rideId });
                    this.io.to('admin').emit('ride:status_update', { rideId: data.rideId, status: 'accepted' });

                    this.rideExclusions.delete(data.rideId);
                    this.activeDispatches.delete(data.rideId);
                } catch (err) {
                    log.error('ride:accept failed:', err);
                    socket.emit('ride:error', { code: 'INTERNAL_ERROR', message: 'Could not accept the ride right now. Please try again.' });
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

                    // Geofence: driver must be at the pickup to mark arrived.
                    const live = await getDriverLiveLocation(data.driverId);
                    const pickup: LatLng | null = (ride.pickupLat != null && ride.pickupLng != null)
                        ? { lat: Number(ride.pickupLat), lng: Number(ride.pickupLng) } : null;
                    const gate = evaluateProximityGate(live, pickup, RideIntegrityConfig.pickupArrivalRadiusM);
                    log.info(JSON.stringify({ event: 'ride_arrived_geocheck', rideId: data.rideId, driverId: data.driverId, distanceM: gate.distanceM, radiusM: RideIntegrityConfig.pickupArrivalRadiusM, block: gate.block, flagged: gate.flagged, outcome: gate.outcome, fresh: live?.fresh ?? false }));
                    if (gate.block) {
                        socket.emit('ride:error', { code: 'TOO_FAR_FROM_PICKUP', message: `You must be at the pickup point to mark arrived — you appear to be about ${Math.round(gate.distanceM || 0)}m away.` });
                        return;
                    }

                    await AppDataSource.getRepository(Ride).update(data.rideId, {
                        status: 'arrived' as any,
                        arrivedAt: new Date(),
                        arrivedLat: gate.driverLoc?.lat ?? null,
                        arrivedLng: gate.driverLoc?.lng ?? null,
                        arrivedPickupDistanceM: gate.distanceM,
                        ...(gate.flagged ? { suspicious: true, suspiciousReason: mergeReasons(ride.suspiciousReason, [`arrived:${gate.outcome}`]) } : {}),
                    } as any);
                    this.broadcastToRide(data.rideId, 'ride:status_update', { rideId: data.rideId, status: 'arrived' });
                    NotificationService.sendToUser(ride.passengerId, UserRole.PASSENGER, 'Driver Arrived!', 'Your driver has reached the pickup location.', {
                        type: 'RIDE_ARRIVED', rideId: data.rideId, intent: 'active',
                    });
                    this.io.to('admin').emit('ride:status_update', { rideId: data.rideId, status: 'arrived' });
                } catch (err) {
                    log.error('Failed to update ride to arrived:', err);
                    socket.emit('ride:error', { code: 'INTERNAL_ERROR', message: 'Could not update your arrival status. Please try again.' });
                }
            });

            // --- Trip Started ---
            socket.on('ride:start', async (raw) => {
                const data = validate(Schemas.rideDriverAction, raw, socket);
                if (!data) return;
                try {
                    const ride = await this.validateRideState(data.rideId, ['arrived', 'accepted']);
                    if (!ride) return;

                    // Geofence: the trip may only start from the pickup point.
                    const live = await getDriverLiveLocation(data.driverId);
                    const pickup: LatLng | null = (ride.pickupLat != null && ride.pickupLng != null)
                        ? { lat: Number(ride.pickupLat), lng: Number(ride.pickupLng) } : null;
                    const gate = evaluateProximityGate(live, pickup, RideIntegrityConfig.pickupArrivalRadiusM);
                    log.info(JSON.stringify({ event: 'ride_start_geocheck', rideId: data.rideId, driverId: data.driverId, distanceM: gate.distanceM, radiusM: RideIntegrityConfig.pickupArrivalRadiusM, block: gate.block, flagged: gate.flagged, outcome: gate.outcome, fresh: live?.fresh ?? false }));
                    if (gate.block) {
                        socket.emit('ride:error', { code: 'TOO_FAR_FROM_PICKUP', message: `You must be at the passenger's pickup point to start the trip — you appear to be about ${Math.round(gate.distanceM || 0)}m away.` });
                        return;
                    }

                    await AppDataSource.getRepository(Ride).update(data.rideId, {
                        status: 'in_progress' as any,
                        startedAt: new Date(),
                        startLat: gate.driverLoc?.lat ?? null,
                        startLng: gate.driverLoc?.lng ?? null,
                        startPickupDistanceM: gate.distanceM,
                        ...(gate.flagged ? { suspicious: true, suspiciousReason: mergeReasons(ride.suspiciousReason, [`start:${gate.outcome}`]) } : {}),
                    } as any);
                    // Send 'started' to match the passenger UI's expected status string
                    this.broadcastToRide(data.rideId, 'ride:status_update', { rideId: data.rideId, status: 'started' });
                    NotificationService.sendToUser(ride.passengerId, UserRole.PASSENGER, 'Trip Started', 'You are now on your trip.', {
                        type: 'TRIP_STARTED', rideId: data.rideId, intent: 'active',
                    });
                    this.io.to('admin').emit('ride:status_update', { rideId: data.rideId, status: 'in_progress' });
                } catch (err) {
                    log.error('Failed to update ride to in_progress:', err);
                    socket.emit('ride:error', { code: 'INTERNAL_ERROR', message: 'Could not start the trip right now. Please try again.' });
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

                    const isCashPayment = ride.paymentMode === 'cash';
                    const rideRepo = AppDataSource.getRepository(Ride);

                    // SERVER-AUTHORITATIVE FARE: never trust the client-supplied
                    // amount for charging. Charge the stored quoted fare; the
                    // client value is recorded only as audit evidence.
                    const baseFare = Number(ride.fare);
                    const finalFare = baseFare;
                    const clientSuppliedFare = (typeof data.totalFare === 'number') ? data.totalFare : null;
                    const fareDifference = clientSuppliedFare != null ? clientSuppliedFare - finalFare : null;

                    // ANTI-FRAUD: validate real movement using the driver's live GPS.
                    const endLive = await getDriverLiveLocation(data.driverId);
                    const startLoc: LatLng | null = (ride.startLat != null && ride.startLng != null)
                        ? { lat: Number(ride.startLat), lng: Number(ride.startLng) } : null;
                    const destination: LatLng | null = (ride.destinationLat != null && ride.destinationLng != null)
                        ? { lat: Number(ride.destinationLat), lng: Number(ride.destinationLng) } : null;
                    const integrity = evaluateCompletion({
                        startLoc,
                        endLive,
                        destination,
                        startedAt: ride.startedAt ? new Date(ride.startedAt) : null,
                        now: new Date(),
                    });

                    // If the client tried to inflate the fare, that is itself a flag.
                    const reasons = [...integrity.reasons];
                    if (fareDifference != null && fareDifference > 0) reasons.push('client_fare_above_quote');
                    const suspicious = reasons.length > 0;
                    const holdPayment = integrity.holdPayment; // only HARD anomalies hold money

                    log.info(JSON.stringify({
                        event: 'ride_complete_integrity', rideId: data.rideId, driverId: data.driverId,
                        paymentMode: ride.paymentMode, finalFare, clientSuppliedFare, fareDifference,
                        endDestinationDistanceM: integrity.endDestinationDistanceM,
                        movementDistanceM: integrity.movementDistanceM, tripDurationSec: integrity.durationSec,
                        endFresh: endLive?.fresh ?? false, suspicious, holdPayment, reasons,
                    }));

                    // Persist all evidence up front (regardless of the money decision).
                    await rideRepo.update(data.rideId, {
                        endLat: integrity.endLoc?.lat ?? null,
                        endLng: integrity.endLoc?.lng ?? null,
                        endDestinationDistanceM: integrity.endDestinationDistanceM,
                        movementDistanceM: integrity.movementDistanceM,
                        tripDurationSec: integrity.durationSec,
                        clientSuppliedFare,
                        finalFare,
                        suspicious: suspicious || undefined,
                        suspiciousReason: suspicious ? mergeReasons(ride.suspiciousReason, reasons) : ride.suspiciousReason,
                    } as any);

                    let paymentSucceeded = false;
                    let held = false;

                    if (holdPayment) {
                        // HOLD: do NOT debit the passenger / settle commission. Mark
                        // for admin review; ride still completes so nobody is stuck.
                        held = true;
                        await rideRepo.update(data.rideId, { paymentHeld: true, suspicious: true } as any);
                        log.warn(JSON.stringify({ level: 'warn', event: 'payment_held_for_review', rideId: data.rideId, reasons }));
                        this.io.to('admin').emit('ride:held_for_review', { rideId: data.rideId, reasons, finalFare, paymentMode: ride.paymentMode });
                    } else {
                        // Normal settlement using the server-authoritative fare.
                        log.info(`Processing financials for completed ride ${data.rideId} — fare: ${finalFare}`);
                        try {
                            await WalletService.postRideFinancials({
                                rideId: data.rideId,
                                passengerId: ride.passengerId,
                                driverId: ride.driverId,
                                totalFare: finalFare,
                                isCash: isCashPayment,
                            });
                            paymentSucceeded = true;
                        } catch (e: any) {
                            log.error(JSON.stringify({ level: 'error', event: 'payment_failed', rideId: data.rideId, error: e.message }));
                            await rideRepo.update(data.rideId, { paymentFailed: true } as any);
                            this.io.to('admin').emit('ride:payment_failed', { rideId: data.rideId, error: e.message });
                            socket.emit('ride:payment_error', {
                                rideId: data.rideId,
                                message: 'Payment processing failed. Our team will resolve this shortly.',
                            });
                        }
                    }

                    // Always mark the ride completed so driver and passenger are never stuck.
                    await rideRepo.update(data.rideId, { status: 'completed' as any, completedAt: new Date() });

                    const adminStatus = held ? 'completed_held_for_review' : (paymentSucceeded ? 'completed' : 'completed_payment_failed');
                    this.io.to('admin').emit('ride:status_update', { rideId: data.rideId, status: adminStatus });
                    this.broadcastToRide(data.rideId, 'ride:finished', { rideId: data.rideId });

                    NotificationService.sendToUser(data.passengerId, UserRole.PASSENGER, 'Trip Completed', 'Hope you enjoyed the ride!', {
                        type: 'TRIP_COMPLETED', rideId: data.rideId, intent: 'receipt',
                    });

                    // Payment held for review — tell both parties so nobody thinks they were charged/paid.
                    if (held) {
                        NotificationService.sendToUser(data.passengerId, UserRole.PASSENGER, 'Payment Under Review',
                            "Your payment for this trip is being reviewed. You won't be charged until it's cleared.", {
                            type: 'PAYMENT_HELD', rideId: data.rideId, intent: 'receipt',
                        });
                        if (ride.driverId) {
                            NotificationService.sendToUser(ride.driverId, UserRole.DRIVER, 'Ride Under Review',
                                'This ride was completed but payment is held for review.', {
                                type: 'PAYMENT_HELD', rideId: data.rideId, intent: 'receipt',
                            });
                        }
                    }
                } catch (err) {
                    log.error('Ride completion lifecycle failed:', err);
                    socket.emit('ride:error', { code: 'INTERNAL_ERROR', message: 'Could not complete the ride right now. Please try again.' });
                }
            });

            // --- SOS Alert ---
            socket.on('ride:sos', async (raw) => {
                const data = validate(Schemas.sosAlert, raw, socket);
                if (!data) return;

                try {
                    const rideRepo = AppDataSource.getRepository(Ride);
                    const ride = await rideRepo.findOne({ where: { rideId: data.rideId } });
                    if (!ride) return socket.emit('ride:error', { message: 'Ride not found' });

                    const sosRepo = AppDataSource.getRepository(SosAlert);
                    const alert = sosRepo.create({
                        rideId: data.rideId,
                        initiatorId: data.initiatorId,
                        initiatorRole: data.initiatorRole as any,
                        reason: data.reason,
                        description: data.description,
                        lat: data.lat,
                        lng: data.lng,
                        status: SosAlertStatus.ACTIVE
                    });
                    await sosRepo.save(alert);

                    // Fetch names for context
                    let passengerName = "Passenger";
                    let driverName = "Driver";
                    let passengerPhone = "";
                    let driverPhone = "";

                    const pUser = await AppDataSource.getRepository(User).findOne({ where: { id: ride.passengerId } });
                    if (pUser) {
                        passengerName = `${pUser.firstName} ${pUser.lastName}`;
                        passengerPhone = pUser.phone || "";
                    }

                    if (ride.driverId) {
                        const dProfile = await AppDataSource.getRepository(DriverProfile).findOne({ where: { userId: ride.driverId } });
                        if (dProfile) driverName = `${dProfile.firstName} ${dProfile.lastName}`;
                        const dUser = await AppDataSource.getRepository(User).findOne({ where: { id: ride.driverId } });
                        if (dUser) driverPhone = dUser.phone || "";
                    }

                    // Alert admins immediately
                    this.io.to('admin').emit('admin:sos_alert', {
                        id: alert.id,
                        rideId: ride.rideId,
                        initiatorRole: alert.initiatorRole,
                        reason: alert.reason || "Emergency Triggered",
                        description: alert.description || "",
                        lat: alert.lat,
                        lng: alert.lng,
                        passengerName,
                        passengerPhone,
                        driverName,
                        driverPhone,
                        timestamp: alert.createdAt
                    });

                    // Acknowledge back to the sender discreetly
                    socket.emit('ride:sos_received', { message: 'Help is on the way.' });
                    log.error(`[CRITICAL] SOS Alert triggered for ride ${ride.rideId} by ${alert.initiatorRole}`);
                } catch (err) {
                    log.error('Failed to handle SOS alert:', err);
                }
            });
        });
    }

    private async startDispatchLoop(rideId: string, lat: number, lng: number, payload: any) {
        const radiuses = [3, 5];
        const isCash = payload.isCash === true;
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

            log.info(`Searching in ${radius}km radius for ride ${rideId} (${isCash ? 'cash' : 'wallet'})`);
            this.io.to(`ride:${rideId}`).emit('ride:searching', { radius });

            const nearbyDrivers = await DispatchService.findNearbyDrivers(lat, lng, radius);
            const exclusions = this.rideExclusions.get(rideId) || new Set();
            let eligible = nearbyDrivers.filter(id => !exclusions.has(id));

            // Filter out suspended/rejected drivers — they must not receive ride requests
            if (eligible.length > 0) {
                const profiles = await AppDataSource.getRepository(DriverProfile).findBy(
                    eligible.map(id => ({ userId: id }))
                );
                const blockedIds = new Set(
                    profiles
                        .filter(p => p.status === 'suspended' || p.status === 'rejected')
                        .map(p => p.userId)
                );
                if (blockedIds.size > 0) {
                    eligible = eligible.filter(id => !blockedIds.has(id));
                    log.info(`[DISPATCH] Filtered ${blockedIds.size} suspended/rejected drivers for ride ${rideId}`);
                }
            }

            // For cash rides, strip out debt-blocked drivers before dispatching
            if (isCash && eligible.length > 0) {
                eligible = await WalletService.filterCashEligibleDrivers(eligible);
                log.info(`[DISPATCH] Cash ride ${rideId}: ${eligible.length} eligible after debt filter at ${radius}km`);
            }

            const targetDrivers = eligible;

            if (targetDrivers.length > 0) {
                const notifiedSet = this.activeDispatches.get(rideId) || new Set();
                // Fetch passenger phone once for this dispatch batch
                const passengerUser = await AppDataSource.getRepository(User).findOne({ where: { id: payload.passengerId } });
                const rideRecord = await AppDataSource.getRepository(Ride).findOne({ where: { rideId } });
                const enrichedPayload = { ...payload, passengerPhone: passengerUser?.phone ?? null, pickupCode: rideRecord?.pickupCode ?? null };
                for (const driverId of targetDrivers) {
                    notifiedSet.add(driverId);
                    this.io.to(`driver:${driverId}`).emit('ride:request', enrichedPayload);
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
            if (finalRide.passengerId) {
                NotificationService.sendToUser(finalRide.passengerId, UserRole.PASSENGER, 'No Driver Found',
                    "We couldn't find a nearby driver. Please try again.", {
                    type: 'NO_DRIVER', rideId, intent: 'retry',
                });
            }
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
