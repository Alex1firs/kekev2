import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { DispatchService } from '../services/dispatch_service';
import { NotificationService } from '../services/notification_service';
import {
    DispatchOrchestrator,
    DispatchRun,
    DispatchPorts,
    OfferDelivery,
    EligibilityResult,
} from '../services/dispatch_orchestrator';
import { loadDispatchConfig } from '../config/dispatch_config';
import { DriverEligibilityService } from '../services/driver_eligibility_service';
import { DispatchMonitorService } from '../services/dispatch_monitor_service';
import { DispatchMonitorQueryService } from '../services/dispatch_monitor_query_service';
import { RideCleanupService } from '../services/ride_cleanup_service';
import { loadStaleRideConfig, StaleResolution } from '../config/stale_ride_config';
import { DispatchEventType } from '../models/DispatchEvent';
import { projectDispatchEvent } from '../services/dispatch_event_projection';
import { User, UserRole } from '../models/User';
import { AppDataSource } from '../config/data_source';
import { Ride } from '../models/Ride';
import { DriverProfile } from '../models/DriverProfile';
import { redis } from '../config/redis';
import { WalletService, DEBT_CASH_BLOCK, DEBT_HARD_BLOCK } from '../services/wallet_service';
import { In } from 'typeorm';
import { SosAlert, SosAlertStatus } from '../models/SosAlert';
import { toLocalDialable } from '../utils/phone';
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

// Structured, always-on (unless RESERVATION_LOG=false) log for the driver
// reservation lifecycle — invaluable for field debugging of dispatch/concurrency.
// Kept separate from `log.info` so it survives the prod info-suppression above.
const RESERVATION_LOG = process.env.RESERVATION_LOG !== 'false';
function rlog(event: string, fields: Record<string, any>): void {
    if (!RESERVATION_LOG) return;
    try { console.log(JSON.stringify({ level: 'info', scope: 'dispatch', event, ...fields })); } catch { /* noop */ }
}

/**
 * How old a passenger's active-ride slot must be, with no matching ride row,
 * before it is treated as orphaned rather than as a request still committing.
 * Comfortably longer than any plausible insert, far shorter than the 3h TTL.
 */
const ORPHAN_SLOT_GRACE_MS = Number(process.env.PASSENGER_SLOT_ORPHAN_GRACE_MS) || 30_000;

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
        // Operational telemetry for the admin monitor. Optional so older app
        // builds keep validating; never used for pricing or dispatch decisions.
        estimatedDistanceM:   z.number().int().min(0).max(500_000).optional(),
        estimatedDurationSec: z.number().int().min(0).max(86_400).optional(),
        appVersion:           z.string().max(32).optional(),
        platform:             z.enum(['android', 'ios']).optional(),
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
    // Passenger-consented early drop-off (Option 4 primary / Option 1 confirm).
    rideEndEarly:      z.object({ rideId: id(), passengerId: id(), lat: lat().optional(), lng: lng().optional() }),
    rideEarlyEndReject: z.object({ rideId: id(), passengerId: id() }),
    // Either party's answer to a stale-ride decision prompt.
    staleDecision: z.object({
        rideId: id(),
        userId: id(),
        role: z.enum(['passenger', 'driver']),
        choice: z.enum(['wait', 'cancel']),
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
        socket.emit('ride:error', { code: 'INVALID_REQUEST', message: 'Invalid request data' });
        return null;
    }
    return result.data;
}

export class SocketHandler {
    private io: Server;
    private rideExclusions:   Map<string, Set<string>> = new Map();
    private activeDispatches: Map<string, Set<string>> = new Map();
    // Last ride:request payload per active dispatch, so a driver whose socket
    // was disconnected (e.g. phone locked) can have the offer re-delivered on
    // reconnect instead of silently missing it.
    private dispatchPayloads: Map<string, any> = new Map();
    // Live multi-round dispatch runs, keyed by rideId. Holds each ride's evidence
    // ledger and its abort handle, so rejections/acks/acceptance/cancellation all
    // feed the same run the round loop is reading.
    private dispatchRuns:     Map<string, DispatchRun>  = new Map();
    // Every timer a ride's dispatch created, so nothing is left armed when the
    // run ends for any reason.
    private dispatchTimers:   Map<string, Set<NodeJS.Timeout>> = new Map();
    private driverRideMap:    Map<string, string>       = new Map();
    // Pending driver-initiated early-end confirmations, keyed by rideId. If the
    // passenger doesn't confirm/reject within the window the ride completes with
    // payment held for admin review.
    private earlyEndTimers:   Map<string, NodeJS.Timeout>  = new Map();
    private static readonly EARLY_END_CONFIRM_MS = 90_000;

    /** Clear all in-memory dispatch state for a ride (offer targets + payload). */
    private clearDispatch(rideId: string) {
        this.activeDispatches.delete(rideId);
        this.dispatchPayloads.delete(rideId);
    }

    /**
     * Release the temporary driver reservations this ride is holding (the drivers
     * it was ringing), so they immediately become eligible for other rides.
     * Ownership-checked — only releases keys still owned by THIS ride. Pass
     * exceptDriverId to keep one driver reserved (e.g. the one who just accepted).
     * Safe to call more than once. Reads activeDispatches, so call BEFORE clearDispatch.
     */
    private async releaseRideReservations(rideId: string, reason: string, exceptDriverId?: string): Promise<void> {
        const notified = this.activeDispatches.get(rideId);
        if (!notified || notified.size === 0) return;
        for (const driverId of notified) {
            if (exceptDriverId && driverId === exceptDriverId) continue;
            try {
                const released = await DispatchService.releaseDriver(driverId, rideId);
                if (released) rlog('release', { rideId, driverId, reason });
            } catch (err) {
                log.error('Reservation release failed:', err);
            }
        }
    }

    private broadcastToRide(rideId: string, event: string, data: any) {
        log.info(`[BROADCAST] Ride:${rideId} Event:${event}`);
        this.io.to(`ride:${rideId}`).emit(event, data);
    }

    constructor(io: Server) {
        this.io = io;
        // Admin monitoring receives dispatch events incrementally rather than
        // re-fetching the world on every change.
        DispatchMonitorService.setEmitter((event, payload) => {
            this.io.to('admin').emit(event, payload);
        });
        // Live transient tier: for an in-flight ride the in-memory evidence ledger
        // is authoritative for round and radius, so the monitor prefers it over
        // the persisted projection (which can lag by a write).
        DispatchMonitorQueryService.setLiveContextResolver((rideId) => {
            const run = this.dispatchRuns.get(rideId);
            if (!run) return null;
            const summary = run.evidence.summary(false);
            return {
                dispatchRound: summary.dispatchRound,
                radiusKm: (() => {
                    // No Array.prototype.at under the es2020 target.
                    const lastRound = summary.rounds.length ? summary.rounds[summary.rounds.length - 1] : null;
                    const tiers = lastRound?.radiusTiersKm ?? [];
                    return tiers.length ? tiers[tiers.length - 1] : null;
                })(),
                eligibleDriverCount: summary.eligibleDriverCount,
                offersSentCount: summary.offersSentCount,
                explicitRejectCount: summary.explicitRejectCount,
                expiredOfferCount: summary.expiredOfferCount,
                deliveryFailureCount: summary.deliveryFailureCount,
                acknowledgedCount: summary.acknowledgedCount,
            };
        });
        // The stale-ride cleanup service owns terminal actions but must reach the
        // in-memory dispatch state and the realtime rooms that live here.
        RideCleanupService.setHost({
            abortDispatch: (rideId, reason) => {
                const run = this.dispatchRuns.get(rideId);
                if (run) run.abort('cancelled');
                this.clearDispatchTimers(rideId);
                rlog('dispatch_aborted_by_cleanup', { rideId, reason });
            },
            releaseRideReservations: (rideId, reason) => this.releaseRideReservations(rideId, reason),
            notifiedDrivers: (rideId) => [...(this.activeDispatches.get(rideId) ?? [])],
            forgetDriverRide: (driverId) => { this.driverRideMap.delete(driverId); },
            clearDispatchState: (rideId) => {
                this.dispatchRuns.delete(rideId);
                this.rideExclusions.delete(rideId);
                this.clearDispatch(rideId);
            },
            emitToRide: (rideId, event, payload) => { this.io.to(`ride:${rideId}`).emit(event, payload); },
            emitToDriver: (driverId, event, payload) => { this.io.to(`driver:${driverId}`).emit(event, payload); },
            emitToAdmin: (event, payload) => { this.io.to('admin').emit(event, payload); },
        });

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

            // If a driver's socket drops mid-ring (before accepting), release any
            // reservation they hold so a waiting ride can ring them instead of
            // waiting for the TTL. A driver already ON a ride has no reservation
            // (released at accept), so this is a no-op for them.
            socket.on('disconnect', async () => {
                const driverId = (socket as any).driverId;
                if (!driverId) return;
                try {
                    const onActiveRide = this.driverRideMap.has(driverId);
                    if (!onActiveRide) {
                        const released = await DispatchService.releaseDriver(driverId);
                        if (released) rlog('release', { driverId, reason: 'driver_disconnect' });
                    }
                } catch (err) {
                    log.error('Reservation release on disconnect failed:', err);
                }
            });

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
                // Remember this socket's driver identity so a disconnect can release
                // any reservation the driver is holding (see 'disconnect' below).
                if (data.role === 'driver') (socket as any).driverId = data.userId;
                log.info(`${room} joined`);

                // DISPATCH RECOVERY: if this driver was offered a ride while their
                // socket was down (backgrounded/locked phone), the ride:request
                // event was lost. Re-deliver any still-open offer now that they're
                // back so they can accept it instead of the passenger timing out.
                if (data.role === 'driver') {
                    for (const [rideId, notified] of this.activeDispatches.entries()) {
                        if (!notified.has(data.userId)) continue;
                        const payload = this.dispatchPayloads.get(rideId);
                        if (!payload) continue;
                        try {
                            const ride = await AppDataSource.getRepository(Ride).findOne({ where: { rideId } });
                            if (ride && (ride.status as any) === 'searching') {
                                this.io.to(`driver:${data.userId}`).emit('ride:request', payload);
                                log.info(`[DISPATCH_RECOVERY] Re-sent ride:request ${rideId} to reconnected driver ${data.userId}`);
                            }
                        } catch (err) {
                            log.error('Dispatch recovery re-emit failed:', err);
                        }
                    }
                }
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

                // --- Per-passenger active-ride guard (scoped to THIS passenger only;
                //     never blocks other passengers) ---
                const ACTIVE_RIDE_STATES = ['searching', 'accepted', 'arrived', 'in_progress', 'started'];
                // (A) Atomic Redis NX serializes two simultaneous requests from the
                //     same passenger — only one can win the active-ride slot.
                const claimed = await DispatchService.acquirePassengerActive(passengerId, rideId);
                if (!claimed) {
                    const owner = await DispatchService.getPassengerActive(passengerId);
                    if (owner && owner !== rideId) {
                        const ownerRide = await AppDataSource.getRepository(Ride).findOne({ where: { rideId: owner } });
                        const ownerLive = !!ownerRide && ACTIVE_RIDE_STATES.includes(ownerRide.status as any);
                        // A slot whose ride row does not exist is ambiguous: it is
                        // either a simultaneous sibling still committing its row
                        // (milliseconds old), or an orphan left by a crash or an
                        // early return. Age decides. Without this an orphan locks
                        // the passenger out for the full 3h TTL with nothing in the
                        // app to cancel, because /rides/active/passenger correctly
                        // reports no ride.
                        const slotAgeMs = await DispatchService.getPassengerActiveAgeMs(passengerId);
                        const orphaned = !ownerRide && (slotAgeMs ?? 0) > ORPHAN_SLOT_GRACE_MS;
                        if (ownerLive || (!ownerRide && !orphaned)) {
                            rlog('passenger_guard', { passengerId, rideId, blockedBy: owner, source: 'redis', slotAgeMs });
                            socket.emit('ride:error', { code: 'ACTIVE_RIDE_EXISTS', message: 'You already have an active ride in progress.' });
                            return;
                        }
                        if (orphaned) {
                            rlog('passenger_slot_orphan_reclaimed', { passengerId, rideId, orphanRideId: owner, slotAgeMs });
                        }
                        // Stale slot (owner ride already terminal) — take it over.
                        await DispatchService.releasePassengerActive(passengerId);
                        await DispatchService.acquirePassengerActive(passengerId, rideId);
                    }
                }
                // (B) DB backstop (covers a Redis flush): block if another live ride exists.
                try {
                    const existingActive = await AppDataSource.getRepository(Ride).findOne({
                        where: { passengerId, status: In(ACTIVE_RIDE_STATES as any[]) },
                    });
                    if (existingActive && existingActive.rideId !== rideId) {
                        rlog('passenger_guard', { passengerId, rideId, blockedBy: existingActive.rideId, source: 'db' });
                        // Guard (A) may have just claimed the slot for THIS rideId,
                        // whose ride row we are now abandoning. Releasing it is not
                        // optional: leaving it behind points the slot at a ride that
                        // will never exist, and every subsequent request then fails
                        // guard (A) instead — locking the passenger out long after
                        // the real blocking ride is resolved. Ownership-checked, so
                        // a slot genuinely held by another ride is left alone.
                        await DispatchService.releasePassengerActive(passengerId, rideId);
                        socket.emit('ride:error', { code: 'ACTIVE_RIDE_EXISTS', message: 'You already have an active ride in progress.' });
                        return;
                    }
                } catch (err) {
                    log.error('Passenger active-ride DB check failed:', err);
                }

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
                        estimatedDistanceM: request.estimatedDistanceM ?? null,
                        estimatedDurationSec: request.estimatedDurationSec ?? null,
                    });
                    await rideRepo.save(ride);
                } catch (err) {
                    log.error('Failed to persist ride record:', err);
                    // Don't leak the passenger's active-ride slot if creation failed.
                    await DispatchService.releasePassengerActive(passengerId, rideId);
                    socket.emit('ride:error', { code: 'INTERNAL_ERROR', message: 'Failed to create ride. Please try again.' });
                    return;
                }

                this.rideExclusions.set(rideId, new Set());
                log.info(`Starting dispatch for ride ${rideId}`);
                this.io.to('admin').emit('ride:status_update', { rideId, status: 'searching' });
                // First row of the ride's admin timeline, so the request appears
                // in Live Ride Requests the moment it is created.
                DispatchMonitorService.record({
                    rideId,
                    eventType: DispatchEventType.RIDE_CREATED,
                    dispatchRound: 1,
                    detail: {
                        paymentMode: isCash ? 'cash' : 'wallet',
                        fare,
                        estimatedDistanceM: request.estimatedDistanceM ?? null,
                        estimatedDurationSec: request.estimatedDurationSec ?? null,
                        appVersion: request.appVersion ?? null,
                        platform: request.platform ?? null,
                    },
                });

                // Multi-round dispatch owns its own lifetime ceiling and abort
                // handling (see startDispatchLoop), so there is no outer race that
                // could leave an abandoned loop still ringing drivers after the
                // passenger has already been told the search ended.
                this.startDispatchLoop(rideId, pickupLat, pickupLng, request).catch(async (err: any) => {
                    log.error(JSON.stringify({ level: 'error', event: 'dispatch_crashed', rideId, error: err?.message }));
                    try {
                        await this.releaseRideReservations(rideId, 'dispatch_crashed');
                        if (passengerId) await DispatchService.releasePassengerActive(passengerId, rideId);
                    } catch (_) { /* best effort */ }
                    this.clearDispatchTimers(rideId);
                    this.dispatchRuns.delete(rideId);
                    this.rideExclusions.delete(rideId);
                    this.clearDispatch(rideId);
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

                    if (!ride) return socket.emit('ride:error', { code: 'RIDE_NOT_FOUND', message: 'Ride not found' });
                    if (ride.passengerId !== data.passengerId) return socket.emit('ride:error', { code: 'FORBIDDEN', message: 'Unauthorized cancellation attempt' });

                    const cancellable = ['searching', 'accepted', 'arrived'] as any[];
                    if (!cancellable.includes(ride.status)) {
                        return socket.emit('ride:error', { code: 'INVALID_STATE', message: 'Ride cannot be canceled at this stage' });
                    }

                    await rideRepo.update(data.rideId, { status: 'canceled' as any, completedAt: new Date() });

                    // Abort dispatch NOW so no further round can start and any
                    // in-flight offer window stops waiting. Without this, a
                    // cancellation landing mid-round-one would still be followed by
                    // an automatic round two.
                    const cancelledRun = this.dispatchRuns.get(data.rideId);
                    if (cancelledRun) {
                        cancelledRun.abort('cancelled');
                        rlog('dispatch_cancelled', {
                            rideId: data.rideId,
                            dispatchRound: cancelledRun.evidence.round,
                            summary: cancelledRun.evidence.summary(false),
                        });
                    }
                    DispatchMonitorService.record({
                        rideId: data.rideId,
                        eventType: DispatchEventType.RIDE_CANCELLED,
                        dispatchRound: cancelledRun?.evidence.round ?? null,
                        detail: {
                            cancelledBy: 'passenger',
                            statusBeforeCancel: ride.status,
                            hadAssignedDriver: !!ride.driverId,
                        },
                    });
                    this.clearDispatchTimers(data.rideId);

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

                    // Release every driver this ride was ringing + the passenger slot.
                    await this.releaseRideReservations(data.rideId, 'passenger_cancel');
                    if (ride.driverId) await DispatchService.releaseDriver(ride.driverId, data.rideId);
                    await DispatchService.releasePassengerActive(data.passengerId, data.rideId);
                    this.dispatchRuns.delete(data.rideId);
                    this.rideExclusions.delete(data.rideId);
                    this.clearDispatch(data.rideId);
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

                    // Prevent double-assignment: a driver already on an active ride
                    // cannot accept another until they finish/cancel the current one.
                    const activeForDriver = await AppDataSource.getRepository(Ride).findOne({
                        where: { driverId: data.driverId, status: In(['accepted', 'arrived', 'in_progress'] as any[]) },
                    });
                    if (activeForDriver && activeForDriver.rideId !== data.rideId) {
                        socket.emit('ride:error', { code: 'ALREADY_ON_RIDE', message: 'Finish your current ride before accepting a new one.' });
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

                    const ratingCount = profile.ratingCount ?? 0;
                    const driverDetails = {
                        name: `${profile.firstName} ${profile.lastName}`,
                        plate: profile.vehiclePlate,
                        model: profile.vehicleModel,
                        phone: toLocalDialable(driverUser?.phone) ?? null,
                        photoUrl: profile.photoUrl ?? null,
                        rating: ratingCount > 0 ? Number(((profile.ratingSum ?? 0) / ratingCount).toFixed(2)) : 0,
                        ratingCount,
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

                    // Reservation → assignment. The atomic DB UPDATE above (status
                    // searching→accepted) is the true arbiter and is retained; here we
                    // just confirm/log ownership and release ALL of this ride's ring
                    // reservations. The accepted driver is now excluded from future
                    // dispatch by DB status='accepted' + driverRideMap, so releasing is
                    // race-safe (the DB row was flipped before this release).
                    const resOwner = await DispatchService.getReservationOwner(data.driverId);
                    rlog('assign', { rideId: data.rideId, driverId: data.driverId, reservationOwner: resOwner, ownershipMatched: resOwner === data.rideId });
                    // Stop ALL dispatch activity for this ride immediately — the
                    // in-flight offer window is abandoned rather than run out, and
                    // no further round can start.
                    const acceptedRun = this.dispatchRuns.get(data.rideId);
                    if (acceptedRun) {
                        acceptedRun.noteAcceptance(data.driverId);
                        rlog('acceptance', {
                            rideId: data.rideId,
                            driverId: data.driverId,
                            dispatchRound: acceptedRun.evidence.round,
                            summary: acceptedRun.evidence.summary(false),
                        });
                    }
                    DispatchMonitorService.record({
                        rideId: data.rideId,
                        eventType: DispatchEventType.DRIVER_ACCEPTED,
                        dispatchRound: acceptedRun?.evidence.round ?? null,
                        driverId: data.driverId,
                        detail: {
                            // Time from request creation to assignment.
                            timeToAssignmentMs: currentRide?.createdAt
                                ? Date.now() - new Date(currentRide.createdAt).getTime()
                                : null,
                        },
                        withFreshness: true,
                    });
                    this.clearDispatchTimers(data.rideId);
                    await this.releaseRideReservations(data.rideId, 'assigned');
                    this.rideExclusions.delete(data.rideId);
                    this.clearDispatch(data.rideId);
                } catch (err) {
                    log.error('ride:accept failed:', err);
                    socket.emit('ride:error', { code: 'INTERNAL_ERROR', message: 'Could not accept the ride right now. Please try again.' });
                }
            });

            // --- Driver Offer Acknowledgement (newer driver builds only) ---
            // Device-level proof the offer arrived, as opposed to the transport
            // merely accepting it. Absent from older APKs, hence "where available".
            socket.on('ride:offer_ack', async (raw) => {
                const data = validate(Schemas.rideDriverAction, raw, socket);
                if (!data) return;
                const run = this.dispatchRuns.get(data.rideId);
                if (!run) return;
                run.noteAcknowledgement(data.driverId);
                rlog('offer_acknowledged', {
                    rideId: data.rideId,
                    driverId: data.driverId,
                    dispatchRound: run.evidence.round,
                });
                // The ONLY device-level proof we ever get. Recorded as exactly
                // that: the app confirmed the offer rendered.
                DispatchMonitorService.record({
                    rideId: data.rideId,
                    eventType: DispatchEventType.DEVICE_OFFER_ACK,
                    dispatchRound: run.evidence.round,
                    driverId: data.driverId,
                    withFreshness: true,
                });
            });

            // --- Either party answers the stale-ride decision prompt ---
            // The only path by which a stale ride is cancelled promptly. Both
            // passenger and driver receive the prompt; whoever answers first
            // decides. "wait" buys a bounded extension and tells the other side;
            // "cancel" terminates immediately, attributed to whoever chose it.
            socket.on('ride:stale_decision', async (raw) => {
                const data = validate(Schemas.staleDecision, raw, socket);
                if (!data) return;
                try {
                    const config = loadStaleRideConfig();
                    const rideRepo = AppDataSource.getRepository(Ride);
                    const ride = await rideRepo.findOne({ where: { rideId: data.rideId } });
                    if (!ride) {
                        socket.emit('ride:error', { code: 'RIDE_NOT_FOUND', message: 'Ride not found.' });
                        return;
                    }

                    // Only the two people actually on this ride may decide.
                    const isPassenger = data.role === 'passenger' && ride.passengerId === data.userId;
                    const isDriver = data.role === 'driver' && ride.driverId === data.userId;
                    if (!isPassenger && !isDriver) {
                        socket.emit('ride:error', { code: 'FORBIDDEN', message: 'This ride is not yours.' });
                        return;
                    }
                    if (ride.staleDecisionPromptedAt == null) {
                        socket.emit('ride:error', { code: 'INVALID_STATE', message: 'There is nothing to decide on this ride.' });
                        return;
                    }
                    if (ride.completedAt != null) {
                        socket.emit('ride:error', { code: 'INVALID_STATE', message: 'This ride has already ended.' });
                        return;
                    }

                    // First answer wins. The conditional makes two simultaneous
                    // taps resolve to exactly one decision.
                    const claim = await rideRepo
                        .createQueryBuilder()
                        .update()
                        .set({
                            staleDecisionBy: data.role,
                            staleDecisionChoice: data.choice,
                            staleDecisionAt: new Date(),
                        })
                        .where('"rideId" = :rideId AND "staleDecisionChoice" IS NULL AND "completedAt" IS NULL AND status IN (:...live)',
                            { rideId: data.rideId, live: ['accepted', 'arrived'] })
                        .execute();

                    if (!claim.affected) {
                        socket.emit('ride:stale_decision_ack', {
                            rideId: data.rideId,
                            accepted: false,
                            reason: 'already_decided',
                            decidedBy: ride.staleDecisionBy,
                            decidedChoice: ride.staleDecisionChoice,
                        });
                        return;
                    }

                    DispatchMonitorService.record({
                        rideId: data.rideId,
                        eventType: DispatchEventType.STALE_DECISION_RECEIVED,
                        driverId: ride.driverId,
                        detail: {
                            by: data.role,
                            choice: data.choice,
                            round: ride.staleDecisionRound,
                            respondedWithinMs: ride.staleDecisionPromptedAt
                                ? Date.now() - new Date(ride.staleDecisionPromptedAt).getTime()
                                : null,
                        },
                    });
                    rlog('stale_decision_received', {
                        rideId: data.rideId, by: data.role, choice: data.choice,
                    });

                    if (data.choice === 'cancel') {
                        // Honour it now rather than waiting for the next sweep — the
                        // person is holding their phone waiting for it to happen.
                        const resolution = data.role === 'passenger'
                            ? StaleResolution.PASSENGER_CHOSE_CANCEL
                            : StaleResolution.DRIVER_CHOSE_CANCEL;
                        const outcome = await RideCleanupService.terminate({
                            rideId: data.rideId,
                            reason: resolution,
                            situation: (ride.staleReason as string) ?? undefined,
                            expectedStatuses: ['accepted', 'arrived'],
                            passengerMessage: data.role === 'passenger'
                                ? 'Your ride has been cancelled as you requested. You can book again now.'
                                : 'Your driver could not complete this pickup, so the ride was cancelled. You can book again now.',
                            driverMessage: data.role === 'driver'
                                ? 'This ride has been cancelled as you requested. You can accept new rides now.'
                                : 'The passenger cancelled this ride. You can accept new rides now.',
                            requireDecisionPrompt: true,
                        });
                        socket.emit('ride:stale_decision_ack', {
                            rideId: data.rideId, accepted: outcome.applied, choice: 'cancel',
                        });
                        return;
                    }

                    // choice === 'wait' — extend, bounded, and tell the other side
                    // so they know someone is still engaged.
                    const canWait = ride.staleExtensionCount < config.maxExtensions;
                    if (!canWait) {
                        socket.emit('ride:stale_decision_ack', {
                            rideId: data.rideId,
                            accepted: false,
                            reason: 'extension_limit_reached',
                            message: 'You have already chosen to wait once. Please arrive, start the trip, or cancel.',
                        });
                        return;
                    }

                    const extendedTo = new Date(Date.now() + config.extensionMinutes * 60_000);
                    await rideRepo
                        .createQueryBuilder()
                        .update()
                        .set({
                            staleDeadlineOverrideAt: extendedTo,
                            staleExtensionCount: () => '"staleExtensionCount" + 1',
                            // Re-arm: the next deadline asks again.
                            staleDecisionPromptedAt: null,
                            staleDecisionDeadlineAt: null,
                            staleWarnedAt: null,
                        })
                        .where('"rideId" = :rideId AND "completedAt" IS NULL AND "staleExtensionCount" < :max',
                            { rideId: data.rideId, max: config.maxExtensions })
                        .execute();

                    const notice = {
                        rideId: data.rideId,
                        decidedBy: data.role,
                        choice: 'wait',
                        extendedUntil: extendedTo.toISOString(),
                        minutes: config.extensionMinutes,
                    };
                    // BOTH sides are told — the point of the whole mechanism is
                    // that neither is left uninformed.
                    this.io.to(`ride:${data.rideId}`).emit('ride:stale_decision_resolved', {
                        ...notice,
                        message: data.role === 'driver'
                            ? 'Your driver is still on the way.'
                            : 'Your passenger is still coming.',
                    });
                    if (ride.driverId) {
                        this.io.to(`driver:${ride.driverId}`).emit('ride:stale_decision_resolved', {
                            ...notice,
                            message: data.role === 'passenger'
                                ? 'The passenger is still waiting for you.'
                                : 'You chose to keep going. Please head to the pickup point.',
                        });
                    }
                    socket.emit('ride:stale_decision_ack', { rideId: data.rideId, accepted: true, choice: 'wait' });

                    DispatchMonitorService.record({
                        rideId: data.rideId,
                        eventType: DispatchEventType.STALE_EXTENSION_GRANTED,
                        driverId: ride.driverId,
                        detail: {
                            grantedTo: data.role,
                            minutes: config.extensionMinutes,
                            extendedUntil: extendedTo.toISOString(),
                            extensionNumber: (ride.staleExtensionCount ?? 0) + 1,
                            maxExtensions: config.maxExtensions,
                        },
                    });
                } catch (err) {
                    log.error('ride:stale_decision failed:', err);
                    socket.emit('ride:error', { code: 'INTERNAL_ERROR', message: 'Could not record your choice. Please try again.' });
                }
            });

            // --- Driver confirms they are still coming ---
            // The safe action offered by the stale-ride warning. Buys ONE bounded
            // extension (STALE_EXTENSION_MINUTES), capped by STALE_MAX_EXTENSIONS,
            // so a confirmation can never hold a passenger's slot open forever.
            socket.on('ride:still_coming', async (raw) => {
                const data = validate(Schemas.rideDriverAction, raw, socket);
                if (!data) return;
                try {
                    const config = loadStaleRideConfig();
                    const rideRepo = AppDataSource.getRepository(Ride);
                    const ride = await rideRepo.findOne({ where: { rideId: data.rideId } });
                    if (!ride || ride.driverId !== data.driverId) {
                        socket.emit('ride:error', { code: 'FORBIDDEN', message: 'This ride is not yours.' });
                        return;
                    }
                    if (ride.staleExtensionCount >= config.maxExtensions) {
                        socket.emit('ride:error', {
                            code: 'EXTENSION_LIMIT_REACHED',
                            message: 'You have already confirmed once. Please arrive or cancel the ride.',
                        });
                        return;
                    }

                    const extendedTo = new Date(Date.now() + config.extensionMinutes * 60_000);
                    // Conditional + counter increment in one statement, so two taps
                    // cannot both be granted.
                    const applied = await rideRepo
                        .createQueryBuilder()
                        .update()
                        .set({
                            staleDeadlineOverrideAt: extendedTo,
                            staleExtensionCount: () => '"staleExtensionCount" + 1',
                        })
                        .where('"rideId" = :rideId AND status IN (:...live) AND "completedAt" IS NULL AND "staleExtensionCount" < :max',
                            { rideId: data.rideId, live: ['accepted', 'arrived'], max: config.maxExtensions })
                        .execute();

                    if (!applied.affected) {
                        socket.emit('ride:error', { code: 'INVALID_STATE', message: 'This ride can no longer be extended.' });
                        return;
                    }

                    socket.emit('ride:extension_granted', {
                        rideId: data.rideId,
                        extendedUntil: extendedTo.toISOString(),
                        minutes: config.extensionMinutes,
                    });
                    DispatchMonitorService.record({
                        rideId: data.rideId,
                        eventType: DispatchEventType.STALE_EXTENSION_GRANTED,
                        driverId: data.driverId,
                        detail: {
                            minutes: config.extensionMinutes,
                            extendedUntil: extendedTo.toISOString(),
                            extensionNumber: (ride.staleExtensionCount ?? 0) + 1,
                            maxExtensions: config.maxExtensions,
                        },
                    });
                    rlog('stale_extension_granted', { rideId: data.rideId, driverId: data.driverId, minutes: config.extensionMinutes });
                } catch (err) {
                    log.error('ride:still_coming failed:', err);
                    socket.emit('ride:error', { code: 'INTERNAL_ERROR', message: 'Could not confirm right now. Please try again.' });
                }
            });

            // --- Driver Reject ---
            socket.on('ride:reject', async (raw) => {
                const data = validate(Schemas.rideDriverAction, raw, socket);
                if (!data) return;
                this.rideExclusions.get(data.rideId)?.add(data.driverId);
                // Feed the evidence ledger: an explicit "no" is distinct from an
                // offer that simply expired, and excludes this driver from round two.
                const rejectRun = this.dispatchRuns.get(data.rideId);
                if (rejectRun) {
                    rejectRun.noteRejection(data.driverId);
                    rlog('driver_rejected', {
                        rideId: data.rideId,
                        driverId: data.driverId,
                        dispatchRound: rejectRun.evidence.round,
                    });
                }
                // An explicit decline. `reasonCollected: false` is recorded
                // deliberately: the reject payload carries no reason today, and
                // the monitor must not imply one was given.
                DispatchMonitorService.record({
                    rideId: data.rideId,
                    eventType: DispatchEventType.DRIVER_REJECTED,
                    dispatchRound: rejectRun?.evidence.round ?? null,
                    driverId: data.driverId,
                    detail: { reasonCollected: false },
                    withFreshness: true,
                });
                // Release the reservation right away so this driver can immediately
                // be rung by another waiting ride (ownership-checked).
                try {
                    const released = await DispatchService.releaseDriver(data.driverId, data.rideId);
                    if (released) rlog('release', { rideId: data.rideId, driverId: data.driverId, reason: 'driver_reject' });
                } catch (err) {
                    log.error('Reservation release on reject failed:', err);
                }
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

                    // CONDITIONAL update. validateRideState above is a read, so an
                    // unconditional write here could resurrect a ride the stale
                    // sweep cancelled in between — turning a cancelled ride back
                    // into 'arrived' with its passenger slot already released.
                    const arrivedUpdate = await AppDataSource.getRepository(Ride)
                        .createQueryBuilder()
                        .update()
                        .set({
                            status: 'arrived' as any,
                            arrivedAt: new Date(),
                            arrivedLat: gate.driverLoc?.lat ?? null,
                            arrivedLng: gate.driverLoc?.lng ?? null,
                            arrivedPickupDistanceM: gate.distanceM,
                            ...(gate.flagged ? { suspicious: true, suspiciousReason: mergeReasons(ride.suspiciousReason, [`arrived:${gate.outcome}`]) } : {}),
                        } as any)
                        .where('"rideId" = :rideId AND status = :expected AND "completedAt" IS NULL',
                            { rideId: data.rideId, expected: 'accepted' })
                        .execute();
                    if (!arrivedUpdate.affected) {
                        log.warn(`[SYNC_AUDIT] ride:arrived lost a race for ${data.rideId} — no longer 'accepted'`);
                        socket.emit('ride:expired', { code: 'RIDE_NO_LONGER_ACTIVE', rideId: data.rideId, message: 'This ride is no longer active.' });
                        return;
                    }
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

                    // CONDITIONAL, for the same reason as ride:arrived — a start
                    // must never revive a ride the sweep already cancelled.
                    const startUpdate = await AppDataSource.getRepository(Ride)
                        .createQueryBuilder()
                        .update()
                        .set({
                            status: 'in_progress' as any,
                            startedAt: new Date(),
                            startLat: gate.driverLoc?.lat ?? null,
                            startLng: gate.driverLoc?.lng ?? null,
                            startPickupDistanceM: gate.distanceM,
                            ...(gate.flagged ? { suspicious: true, suspiciousReason: mergeReasons(ride.suspiciousReason, [`start:${gate.outcome}`]) } : {}),
                        } as any)
                        .where('"rideId" = :rideId AND status IN (:...expected) AND "completedAt" IS NULL',
                            { rideId: data.rideId, expected: ['arrived', 'accepted'] })
                        .execute();
                    if (!startUpdate.affected) {
                        log.warn(`[SYNC_AUDIT] ride:start lost a race for ${data.rideId} — no longer arrived/accepted`);
                        socket.emit('ride:expired', { code: 'RIDE_NO_LONGER_ACTIVE', rideId: data.rideId, message: 'This ride is no longer active.' });
                        return;
                    }
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

                    const rideRepo = AppDataSource.getRepository(Ride);

                    // SERVER-AUTHORITATIVE FARE: never trust the client-supplied
                    // amount. Charge the stored quoted fare; the client value is
                    // recorded only as audit evidence.
                    const finalFare = Number(ride.fare);
                    const clientSuppliedFare = (typeof data.totalFare === 'number') ? data.totalFare : null;
                    const fareDifference = clientSuppliedFare != null ? clientSuppliedFare - finalFare : null;

                    // ANTI-FRAUD: validate real movement using the driver's live GPS.
                    const endLive = await getDriverLiveLocation(data.driverId);
                    const startLoc: LatLng | null = (ride.startLat != null && ride.startLng != null)
                        ? { lat: Number(ride.startLat), lng: Number(ride.startLng) } : null;
                    const destination: LatLng | null = (ride.destinationLat != null && ride.destinationLng != null)
                        ? { lat: Number(ride.destinationLat), lng: Number(ride.destinationLng) } : null;
                    const consented = !!ride.passengerConsentedEnd;
                    const integrity = evaluateCompletion({
                        startLoc, endLive, destination,
                        startedAt: ride.startedAt ? new Date(ride.startedAt) : null,
                        now: new Date(),
                        passengerConsentedEnd: consented,
                    });

                    const reasons = [...integrity.reasons];
                    if (fareDifference != null && fareDifference > 0) reasons.push('client_fare_above_quote');
                    const suspicious = reasons.length > 0;

                    log.info(JSON.stringify({
                        event: 'ride_complete_integrity', rideId: data.rideId, driverId: data.driverId,
                        paymentMode: ride.paymentMode, finalFare, clientSuppliedFare, fareDifference, consented,
                        endDestinationDistanceM: integrity.endDestinationDistanceM,
                        movementDistanceM: integrity.movementDistanceM, tripDurationSec: integrity.durationSec,
                        endFresh: endLive?.fresh ?? false, suspicious, holdPayment: integrity.holdPayment, reasons,
                    }));

                    // Persist all evidence up front (regardless of the money decision).
                    await rideRepo.update(data.rideId, {
                        endLat: integrity.endLoc?.lat ?? null,
                        endLng: integrity.endLoc?.lng ?? null,
                        endDestinationDistanceM: integrity.endDestinationDistanceM,
                        movementDistanceM: integrity.movementDistanceM,
                        tripDurationSec: integrity.durationSec,
                        clientSuppliedFare, finalFare,
                        suspicious: suspicious || undefined,
                        suspiciousReason: suspicious ? mergeReasons(ride.suspiciousReason, reasons) : ride.suspiciousReason,
                    } as any);
                    const freshRide = await rideRepo.findOne({ where: { rideId: data.rideId } }) ?? ride;

                    if (integrity.holdPayment) {
                        // Early drop-off? If the ONLY hard reason is ending far from
                        // the destination (real movement + duration) and there's no
                        // consent yet, ask the passenger to confirm rather than hold.
                        const hardSet = new Set(integrity.reasons.filter(r => r !== 'stale_gps_at_completion'));
                        const onlyFarFromDest = hardSet.size === 1 && hardSet.has('ended_far_from_destination');
                        if (!consented && onlyFarFromDest && !this.earlyEndTimers.has(data.rideId)) {
                            await this.startEarlyEndConfirmation(freshRide, finalFare);
                            return; // ride stays active until the passenger responds / times out
                        }
                        await this.settleAndComplete(freshRide, { finalFare, clientSuppliedFare, reasons, hold: true });
                    } else {
                        await this.settleAndComplete(freshRide, { finalFare, clientSuppliedFare, reasons, hold: false });
                    }
                } catch (err) {
                    log.error('Ride completion lifecycle failed:', err);
                    socket.emit('ride:error', { code: 'INTERNAL_ERROR', message: 'Could not complete the ride right now. Please try again.' });
                }
            });

            // --- Passenger-consented early drop-off (primary "End Trip Here" AND
            //     confirming a driver's early-end request both land here) ---
            socket.on('ride:end_early', async (raw) => {
                const data = validate(Schemas.rideEndEarly, raw, socket);
                if (!data) return;
                try {
                    const ride = await this.validateRideState(data.rideId, ['in_progress', 'started']);
                    if (!ride) return;
                    if (ride.passengerId !== data.passengerId) {
                        socket.emit('ride:error', { code: 'FORBIDDEN', message: 'You cannot end this trip.' });
                        return;
                    }

                    const rideRepo = AppDataSource.getRepository(Ride);
                    // Record consent. If the driver didn't request it, the passenger
                    // initiated the early end themselves.
                    await rideRepo.update(data.rideId, {
                        endedEarlyByPassenger: !ride.earlyEndRequestedByDriver,
                        passengerConsentedEnd: true,
                        passengerConsentAt: new Date(),
                        passengerConsentLat: (typeof data.lat === 'number') ? data.lat : null,
                        passengerConsentLng: (typeof data.lng === 'number') ? data.lng : null,
                    } as any);
                    const pending = this.earlyEndTimers.get(data.rideId);
                    if (pending) { clearTimeout(pending); this.earlyEndTimers.delete(data.rideId); }
                    log.info(JSON.stringify({ event: 'early_end_consented', rideId: data.rideId, passengerId: data.passengerId, initiatedByDriver: !!ride.earlyEndRequestedByDriver }));

                    const fresh = await rideRepo.findOne({ where: { rideId: data.rideId } });
                    if (!fresh) return;
                    const finalFare = Number(fresh.fare);

                    // Re-evaluate WITH consent — far-from-destination is forgiven, but
                    // movement / duration / stale-GPS holds still apply.
                    const endLive = await getDriverLiveLocation(fresh.driverId);
                    const startLoc: LatLng | null = (fresh.startLat != null && fresh.startLng != null)
                        ? { lat: Number(fresh.startLat), lng: Number(fresh.startLng) } : null;
                    const destination: LatLng | null = (fresh.destinationLat != null && fresh.destinationLng != null)
                        ? { lat: Number(fresh.destinationLat), lng: Number(fresh.destinationLng) } : null;
                    const integrity = evaluateCompletion({
                        startLoc, endLive, destination,
                        startedAt: fresh.startedAt ? new Date(fresh.startedAt) : null,
                        now: new Date(), passengerConsentedEnd: true,
                    });
                    const blocking = integrity.reasons.filter(r => r !== 'stale_gps_at_completion' && r !== 'ended_far_from_destination');
                    const reasons = [...integrity.reasons, 'passenger_consented_early_end'];

                    await rideRepo.update(data.rideId, {
                        endLat: integrity.endLoc?.lat ?? null,
                        endLng: integrity.endLoc?.lng ?? null,
                        endDestinationDistanceM: integrity.endDestinationDistanceM,
                        movementDistanceM: integrity.movementDistanceM,
                        tripDurationSec: integrity.durationSec,
                        finalFare,
                        suspicious: integrity.reasons.length > 0 || undefined,
                        suspiciousReason: mergeReasons(fresh.suspiciousReason, reasons),
                    } as any);
                    const persisted = await rideRepo.findOne({ where: { rideId: data.rideId } }) ?? fresh;

                    await this.settleAndComplete(persisted, {
                        finalFare, clientSuppliedFare: null, reasons,
                        hold: integrity.holdPayment,
                        reviewReason: integrity.holdPayment ? (blocking.join(',') || 'flagged') : null,
                    });
                } catch (err) {
                    log.error('Early-end (consent) failed:', err);
                    socket.emit('ride:error', { code: 'INTERNAL_ERROR', message: 'Could not end the trip right now. Please try again.' });
                }
            });

            // --- Passenger rejects the driver's early-end request ---
            socket.on('ride:reject_early_end', async (raw) => {
                const data = validate(Schemas.rideEarlyEndReject, raw, socket);
                if (!data) return;
                try {
                    const ride = await this.validateRideState(data.rideId, ['in_progress', 'started']);
                    if (!ride || ride.passengerId !== data.passengerId) return;
                    const pending = this.earlyEndTimers.get(data.rideId);
                    if (pending) { clearTimeout(pending); this.earlyEndTimers.delete(data.rideId); }
                    log.warn(JSON.stringify({ level: 'warn', event: 'early_end_rejected', rideId: data.rideId }));
                    await this.settleAndComplete(ride, {
                        finalFare: Number(ride.fare), clientSuppliedFare: null,
                        reasons: ['ended_far_from_destination', 'passenger_disputed_early_end'],
                        hold: true, reviewReason: 'passenger_disputed_early_end',
                    });
                } catch (err) {
                    log.error('Early-end reject failed:', err);
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
                        passengerPhone = toLocalDialable(pUser.phone) || "";
                    }

                    if (ride.driverId) {
                        const dProfile = await AppDataSource.getRepository(DriverProfile).findOne({ where: { userId: ride.driverId } });
                        if (dProfile) driverName = `${dProfile.firstName} ${dProfile.lastName}`;
                        const dUser = await AppDataSource.getRepository(User).findOne({ where: { id: ride.driverId } });
                        if (dUser) driverPhone = toLocalDialable(dUser.phone) || "";
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

    /**
     * Build the orchestrator ports for one ride. Each port is the real
     * production implementation; the orchestrator itself stays free of
     * socket.io/Postgres/FCM so its round logic can be unit-tested.
     */
    private dispatchPorts(rideId: string, payload: any, run: () => DispatchRun | undefined): DispatchPorts {
        const isCash = payload.isCash === true;

        return {
            findNearby: (lat, lng, radiusKm, limit) =>
                DispatchService.findNearbyDriversWithDistance(lat, lng, radiusKm, limit),

            isDriverAvailable: (driverId) => DispatchService.isDriverAvailable(driverId),

            // Shared with the passenger's nearby-Keke map feed (see
            // DriverEligibilityService) so a marker can never represent supply
            // dispatch would refuse. Dispatch additionally passes this ride's
            // explicit rejectors; the map feed deliberately does not.
            filterEligible: (driverIds: string[]): Promise<EligibilityResult> =>
                DriverEligibilityService.filter(driverIds, {
                    isCash,
                    excluded: this.rideExclusions.get(rideId),
                }),

            getRideStatus: async (id: string) => {
                const ride = await AppDataSource.getRepository(Ride).findOne({ where: { rideId: id } });
                return ride ? (ride.status as unknown as string) : null;
            },

            isRideAssigned: (id: string) => this.isRideAssigned(id),

            sendOffer: async (driverId: string, round: number): Promise<OfferDelivery> => {
                // Enrich once per offer so a re-offered driver still gets the
                // current pickup code and passenger phone.
                const enriched = await this.buildOfferPayload(rideId, payload, round);
                this.dispatchPayloads.set(rideId, enriched);

                // Track the offer so a reconnecting driver can have it re-delivered.
                const notified = this.activeDispatches.get(rideId) ?? new Set<string>();
                notified.add(driverId);
                this.activeDispatches.set(rideId, notified);

                // Socket delivery: only counts if the driver actually has a live
                // socket in their room right now.
                let socketDelivered = false;
                try {
                    const sockets = await this.io.in(`driver:${driverId}`).fetchSockets();
                    socketDelivered = sockets.length > 0;
                } catch (err) {
                    log.warn(`[DISPATCH] socket presence check failed for ${driverId}`);
                }
                this.io.to(`driver:${driverId}`).emit('ride:request', enriched);

                // Push delivery, awaited so its result is real evidence.
                let pushSuccessCount = 0;
                let pushReason: string | undefined;
                try {
                    const push = await NotificationService.sendToUser(
                        driverId,
                        UserRole.DRIVER,
                        'New Ride Request',
                        'You have a new request nearby!',
                        { type: 'NEW_REQUEST', rideId, intent: 'booking', dispatchRound: String(round) },
                    );
                    pushSuccessCount = push.successCount;
                    if (push.successCount === 0) pushReason = push.reason ?? 'push_no_success';
                } catch (err: any) {
                    pushReason = `push_threw:${err?.message ?? 'unknown'}`;
                }

                const delivered = socketDelivered || pushSuccessCount > 0;
                return {
                    delivered,
                    socketDelivered,
                    pushSuccessCount,
                    reason: delivered ? undefined : (pushReason ?? 'no_socket_no_push'),
                };
            },

            emitToRide: (id: string, event: string, data: Record<string, unknown>) => {
                this.io.to(`ride:${id}`).emit(event, data);
            },

            log: (event: string, fields: Record<string, unknown>) => {
                rlog(event, fields);
                // Same hook, second destination: the durable admin trail. A
                // projection of these exact events — never a second ledger.
                this.projectDispatchEvent(rideId, event, fields);
            },

            now: () => Date.now(),

            sleep: (ms: number) => {
                const active = run();
                if (!active) return new Promise<void>((resolve) => setTimeout(resolve, ms));
                if (active.isAborted) return Promise.resolve();
                // Resolves on timeout OR when the run is woken (accept, cancel,
                // all offers answered) — so dispatch reacts immediately instead
                // of sitting out the rest of the offer window.
                return new Promise<void>((resolve) => {
                    let settled = false;
                    const done = () => {
                        if (settled) return;
                        settled = true;
                        clearTimeout(timer);
                        resolve();
                    };
                    const timer = setTimeout(done, ms);
                    this.dispatchTimers.get(rideId)?.add(timer);
                    active.onWake(done);
                });
            },
        };
    }

    /**
     * Fan one orchestrator log event out to the durable admin trail.
     * The mapping itself lives in dispatch_event_projection.ts so it can be
     * tested directly and audited in one place.
     */
    private projectDispatchEvent(rideId: string, event: string, fields: Record<string, any>): void {
        for (const row of projectDispatchEvent(rideId, event, fields)) {
            DispatchMonitorService.record(row);
        }
    }

    /** Offer payload for a driver: the request plus per-ride enrichment. */
    private async buildOfferPayload(rideId: string, payload: any, round: number): Promise<any> {
        const passengerUser = payload.passengerId
            ? await AppDataSource.getRepository(User).findOne({ where: { id: payload.passengerId } })
            : null;
        const rideRecord = await AppDataSource.getRepository(Ride).findOne({ where: { rideId } });
        return {
            ...payload,
            passengerPhone: toLocalDialable(passengerUser?.phone) ?? null,
            pickupCode: rideRecord?.pickupCode ?? null,
            dispatchRound: round,
        };
    }

    /**
     * Run controlled multi-round dispatch for a ride, then resolve the passenger
     * outcome. ONE ride record throughout: rounds never insert a ride, never
     * re-quote a fare and never touch payment, so a second round cannot produce a
     * duplicate ride or a duplicate charge.
     */
    private async startDispatchLoop(rideId: string, lat: number, lng: number, payload: any) {
        const config = loadDispatchConfig();
        const orchestrator = new DispatchOrchestrator(this.dispatchPorts(rideId, payload, () => this.dispatchRuns.get(rideId)), config);
        const run = orchestrator.createRun(rideId);

        this.dispatchRuns.set(rideId, run);
        this.dispatchTimers.set(rideId, new Set());
        this.activeDispatches.set(rideId, new Set());

        // Hard ceiling on the whole search. Unlike the previous Promise.race this
        // ABORTS the run rather than abandoning a still-running loop, so no
        // dispatch activity survives the deadline.
        const lifetimeTimer = setTimeout(() => {
            const active = this.dispatchRuns.get(rideId);
            if (!active || active.isAborted) return;
            rlog('search_lifetime_exceeded', { rideId, maxSearchLifetimeMs: config.maxSearchLifetimeMs });
            active.evidence.markLifetimeExpired();
            active.abort('lifetime_exceeded');
        }, config.maxSearchLifetimeMs);
        this.dispatchTimers.get(rideId)!.add(lifetimeTimer);

        let result: Awaited<ReturnType<DispatchOrchestrator['run']>> | null = null;
        try {
            result = await orchestrator.run(run, { lat, lng });
        } catch (err: any) {
            log.error(JSON.stringify({ level: 'error', event: 'dispatch_failed', rideId, error: err?.message }));
        } finally {
            this.clearDispatchTimers(rideId);
        }

        try {
            if (result && result.stopReason !== 'accepted' && result.stopReason !== 'assigned_elsewhere') {
                await this.finalizeUnsuccessfulDispatch(rideId, result);
            }
        } finally {
            // Release everything this ride was holding, whatever the outcome.
            await this.releaseRideReservations(rideId, `dispatch_${result?.stopReason ?? 'error'}`);
            this.dispatchRuns.delete(rideId);
            this.rideExclusions.delete(rideId);
            this.clearDispatch(rideId);
        }
    }

    /**
     * No driver took the ride. Mark it failed and tell the passenger WHY, using
     * the dispatch evidence rather than candidate-set size.
     */
    private async finalizeUnsuccessfulDispatch(
        rideId: string,
        result: Awaited<ReturnType<DispatchOrchestrator['run']>>,
    ): Promise<void> {
        const rideRepo = AppDataSource.getRepository(Ride);
        const ride = await rideRepo.findOne({ where: { rideId } });

        // Cancelled or already taken → the owning handler already told the
        // passenger; emitting a failure here would contradict it.
        if (!ride) return;
        if ((ride.status as unknown as string) !== 'searching') return;
        if (await this.isRideAssigned(rideId)) return;

        const outcome = result.outcome ?? { code: 'NO_ELIGIBLE_DRIVER' as const, dispatchResult: 'unknown' };
        await rideRepo.update(rideId, { status: 'failed' as any });

        rlog('dispatch_outcome', {
            rideId,
            stopReason: result.stopReason,
            code: outcome.code,
            dispatchResult: outcome.dispatchResult,
            summary: result.summary,
        });

        this.io.to(`ride:${rideId}`).emit('ride:failed', {
            code: outcome.code,
            dispatchResult: outcome.dispatchResult,
            ...DispatchOrchestrator.publicPayload(result.summary),
            // Retained from the earlier payload shape. Older passenger builds
            // read `code`/`dispatchResult`/`message` and ignore the new counts,
            // so they keep behaving correctly; `driversRung` now means
            // genuinely-delivered offers rather than candidate-set membership.
            driversRung: result.summary.driversRung,
            message: 'No drivers available nearby',
        });
        this.io.to('admin').emit('ride:status_update', { rideId, status: 'failed' });

        if (ride.passengerId) {
            NotificationService.sendToUser(
                ride.passengerId,
                UserRole.PASSENGER,
                'No Driver Found',
                "We couldn't find a nearby driver. Please try again.",
                { type: 'NO_DRIVER', rideId, intent: 'retry' },
            );
            // Ride is terminal — free the passenger's single active-ride slot.
            await DispatchService.releasePassengerActive(ride.passengerId, rideId);
        }
    }

    /** Cancel and forget every timer this ride's dispatch created. */
    private clearDispatchTimers(rideId: string): void {
        const timers = this.dispatchTimers.get(rideId);
        if (!timers) return;
        for (const t of timers) clearTimeout(t);
        this.dispatchTimers.delete(rideId);
    }

    /**
     * Settle-or-hold a finished ride, mark it completed, and notify both parties.
     * Shared by the driver ride:complete path and the passenger early-end paths.
     * The hold-vs-settle decision is made by the caller from evaluateCompletion.
     */
    private async settleAndComplete(
        ride: any,
        args: { finalFare: number; clientSuppliedFare: number | null; reasons: string[]; hold: boolean; reviewReason?: string | null }
    ): Promise<void> {
        const rideRepo = AppDataSource.getRepository(Ride);
        const rideId = ride.rideId;
        const isCash = ride.paymentMode === 'cash';

        // Any pending early-end confirmation is now resolved.
        const pending = this.earlyEndTimers.get(rideId);
        if (pending) { clearTimeout(pending); this.earlyEndTimers.delete(rideId); }
        // The driver is no longer on an active ride: clear the assignment mapping,
        // drop any lingering reservation, and free the passenger's active-ride slot.
        // The driver returns to the available pool only via a fresh heartbeat
        // (their availability key), so completion never forces a stale driver online.
        if (ride.driverId) {
            this.driverRideMap.delete(ride.driverId);
            await DispatchService.releaseDriver(ride.driverId, rideId);
            rlog('release', { rideId, driverId: ride.driverId, reason: 'ride_complete' });
        }
        if (ride.passengerId) await DispatchService.releasePassengerActive(ride.passengerId, rideId);

        let paymentSucceeded = false;
        const held = args.hold;

        if (held) {
            await rideRepo.update(rideId, {
                paymentHeld: true,
                suspicious: true,
                reviewReason: args.reviewReason ?? ride.reviewReason ?? null,
            } as any);
            log.warn(JSON.stringify({ level: 'warn', event: 'payment_held_for_review', rideId, reasons: args.reasons, reviewReason: args.reviewReason ?? null }));
            this.io.to('admin').emit('ride:held_for_review', { rideId, reasons: args.reasons, reviewReason: args.reviewReason ?? null, finalFare: args.finalFare, paymentMode: ride.paymentMode });
        } else {
            log.info(`Processing financials for completed ride ${rideId} — fare: ${args.finalFare}`);
            try {
                await WalletService.postRideFinancials({
                    rideId, passengerId: ride.passengerId, driverId: ride.driverId,
                    totalFare: args.finalFare, isCash,
                });
                paymentSucceeded = true;
            } catch (e: any) {
                log.error(JSON.stringify({ level: 'error', event: 'payment_failed', rideId, error: e.message }));
                await rideRepo.update(rideId, { paymentFailed: true } as any);
                this.io.to('admin').emit('ride:payment_failed', { rideId, error: e.message });
            }
        }

        await rideRepo.update(rideId, { status: 'completed' as any, completedAt: new Date() });

        const adminStatus = held ? 'completed_held_for_review' : (paymentSucceeded ? 'completed' : 'completed_payment_failed');
        this.io.to('admin').emit('ride:status_update', { rideId, status: adminStatus });
        this.broadcastToRide(rideId, 'ride:finished', { rideId });

        NotificationService.sendToUser(ride.passengerId, UserRole.PASSENGER, 'Trip Completed', 'Hope you enjoyed the ride!', {
            type: 'TRIP_COMPLETED', rideId, intent: 'receipt',
        });
        if (held) {
            NotificationService.sendToUser(ride.passengerId, UserRole.PASSENGER, 'Payment Under Review',
                "Your payment for this trip is being reviewed. You won't be charged until it's cleared.", {
                type: 'PAYMENT_HELD', rideId, intent: 'receipt',
            });
            if (ride.driverId) {
                NotificationService.sendToUser(ride.driverId, UserRole.DRIVER, 'Ride Under Review',
                    'This ride was completed but payment is held for review.', {
                    type: 'PAYMENT_HELD', rideId, intent: 'receipt',
                });
                // Release the driver app from any "awaiting confirmation" state.
                this.io.to(`driver:${ride.driverId}`).emit('ride:early_end_held', { rideId, reviewReason: args.reviewReason ?? null });
            }
        }
    }

    /**
     * Driver ended the trip far from the destination but with real movement and
     * duration and no consent yet. Ask the passenger to confirm the early
     * drop-off; if they don't within the window, the ride completes with payment
     * held for admin review (never auto-approved).
     */
    private async startEarlyEndConfirmation(ride: any, finalFare: number): Promise<void> {
        const rideId = ride.rideId;
        await AppDataSource.getRepository(Ride).update(rideId, { earlyEndRequestedByDriver: true } as any);

        this.io.to(`ride:${rideId}`).emit('ride:early_end_request', { rideId });
        NotificationService.sendToUser(ride.passengerId, UserRole.PASSENGER, 'Confirm Drop-off',
            'Your driver says you were dropped off here. Please confirm in the app.', {
            type: 'EARLY_END_REQUEST', rideId, intent: 'confirm',
        });
        if (ride.driverId) {
            this.io.to(`driver:${ride.driverId}`).emit('ride:awaiting_confirmation', {
                rideId,
                message: "You're far from the booked destination — waiting for the passenger to confirm the drop-off.",
            });
        }
        log.info(JSON.stringify({ event: 'early_end_requested', rideId, driverId: ride.driverId }));

        const timer = setTimeout(async () => {
            this.earlyEndTimers.delete(rideId);
            try {
                const rideRepo = AppDataSource.getRepository(Ride);
                const fresh = await rideRepo.findOne({ where: { rideId } });
                if (!fresh) return;
                // Only act if still un-resolved (not confirmed/rejected/completed meanwhile).
                if ((fresh.status as any) !== 'in_progress' && (fresh.status as any) !== 'started') return;
                if (fresh.passengerConsentedEnd) return;
                log.warn(JSON.stringify({ level: 'warn', event: 'early_end_timeout', rideId }));
                await this.settleAndComplete(fresh, {
                    finalFare, clientSuppliedFare: null,
                    reasons: ['ended_far_from_destination', 'early_end_no_passenger_response'],
                    hold: true, reviewReason: 'early_end_no_passenger_response',
                });
            } catch (err) {
                log.error('Early-end timeout handler failed:', err);
            }
        }, SocketHandler.EARLY_END_CONFIRM_MS);
        this.earlyEndTimers.set(rideId, timer);
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
