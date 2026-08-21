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
import {
    loadStaleRideConfig, StaleResolution, RideDelayState,
    RideActivityType, ActivityKind,
} from '../config/stale_ride_config';
import { RideActivityService } from '../services/ride_activity_service';
import { DispatchEventType } from '../models/DispatchEvent';
import { projectDispatchEvent } from '../services/dispatch_event_projection';
import { RideOperationsSwitch } from '../services/ride_operations_switch';
import { RideControlService } from '../services/ride_control_service';
import { OperationsDispatchService } from '../services/operations_dispatch_service';
import { OperationsBroadcastService } from '../services/operations_broadcast_service';
import { WalletBroadcastService } from '../services/wallet_broadcast_service';
import {
    RideOutcomeCode,
    CancelActorRole,
    outcomeFromDispatchCode,
} from '../services/ride_outcome';
import { publishCommunicationEvent } from '../services/communication_events';
import { User, UserRole } from '../models/User';
import { AppDataSource } from '../config/data_source';
import { Ride } from '../models/Ride';
import { DriverProfile } from '../models/DriverProfile';
import { redis } from '../config/redis';
import { ParkAutoPresenceService } from '../services/park_auto_presence_service';
import { WalletService, DEBT_CASH_BLOCK, DEBT_HARD_BLOCK } from '../services/wallet_service';
import { In } from 'typeorm';
import { SosAlert, SosAlertStatus } from '../models/SosAlert';
import { toLocalDialable } from '../utils/phone';
import { ContactAccessService } from '../services/contact_access_service';
import { ParkDispatchService } from '../services/park_dispatch_service';
import { StaffAuthService } from '../services/staff_auth_service';
import {
    RideIntegrityConfig,
    getDriverLiveLocation,
    evaluateProximityGate,
    evaluateCompletion,
    mergeReasons,
    LatLng,
} from '../services/ride_integrity_service';
import { coordinationEventId } from '../services/ride_coordination_contract';

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
        role: z.enum(['passenger', 'driver', 'admin', 'ride', 'park', 'ops']),
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
        // Structured locality, captured by the passenger app from the same
        // geocoder response the address line comes from. Optional exactly like
        // the fields above: an older build sends none of these and validates
        // unchanged, and a geocoder that returned nothing simply omits them.
        // Never used for pricing, dispatch or eligibility — coordinates remain
        // authoritative for everything the ride actually depends on.
        pickupSubLocality:      z.string().max(120).optional(),
        pickupLocality:         z.string().max(120).optional(),
        pickupCity:             z.string().max(120).optional(),
        pickupState:            z.string().max(120).optional(),
        destinationSubLocality: z.string().max(120).optional(),
        destinationLocality:    z.string().max(120).optional(),
        destinationCity:        z.string().max(120).optional(),
        destinationState:       z.string().max(120).optional(),
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
    // Deliberate interaction proving the ride is still being coordinated.
    rideActivity: z.object({
        rideId: id(),
        userId: id(),
        role: z.enum(['passenger', 'driver']),
        type: z.enum([
            'driver_still_coming', 'passenger_keep_waiting', 'chat_message',
            'call_attempt', 'location_shared', 'passenger_acknowledged_arrival',
        ]),
    }),
    // One party asks to cancel; the other answers.
    rideCancelRequest: z.object({
        rideId: id(),
        userId: id(),
        role: z.enum(['passenger', 'driver']),
        reason: z.string().max(200).optional(),
    }),
    rideCancelResponse: z.object({
        rideId: id(),
        userId: id(),
        role: z.enum(['passenger', 'driver']),
        decision: z.enum(['accept', 'continue']),
    }),
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

        // Liveness evidence: is this user's socket actually connected right now?
        // Used to tell "slow" from "gone" — a passenger with the app open is not
        // an abandoned ride, however long the driver has taken.
        // Park Dispatch borrows exactly the capabilities it needs and holds no
        // socket.io reference or in-memory dispatch state of its own. Note that
        // `assignDriver` is THIS class's single assignment method — the park
        // path cannot invent an alternative ride flow.
        // Operations Dispatch borrows exactly one capability: the SAME
        // assignment method Park and direct acceptance use. It holds no socket
        // reference, no dispatch state, and cannot reach any other path — so
        // there is no way for a manual assignment to diverge from an automatic
        // one, which is the whole point of routing it through here.
        // A driver's wallet screen updates itself when money moves, rather than
        // showing a figure that was true when the screen opened.
        WalletBroadcastService.setEmitter((driverId, event, payload) => {
            this.io.to(`driver:${driverId}`).emit(event, payload);
        });

        OperationsBroadcastService.setEmitter((event, payload) => {
            this.io.to('ops').emit(event, payload);
        });

        OperationsDispatchService.setHost({
            assignDriver: async (a) => {
                const result = await this.assignDriverToRide({
                    rideId: a.rideId,
                    driverId: a.driverId,
                    source: 'operations',
                    assignedByStaffId: a.assignedByStaffId,
                });
                return result.ok
                    ? { ok: true }
                    : { ok: false, code: result.code, message: result.message };
            },
            emitToRide: (rideId, event, payload) => { this.io.to(`ride:${rideId}`).emit(event, payload); },
            emitToAdmin: (event, payload) => { this.io.to('admin').emit(event, payload); },
            emitToOps: (event, payload) => { this.io.to('ops').emit(event, payload); },
            abortDispatch: (rideId, reason) => {
                // Stops NEW offers. Deliberately does not cancel an offer
                // already sitting on a driver's screen — that driver may be
                // about to accept, and the conditional UPDATE will arbitrate.
                const run = this.dispatchRuns.get(rideId);
                if (run) run.abort(reason);
            },
            releaseAssignedDriver: (a) => this.releaseAssignedDriver(a),
        });

        ParkDispatchService.setHost({
            assignDriver: async (a) => {
                const result = await this.assignDriverToRide({
                    rideId: a.rideId,
                    driverId: a.driverId,
                    source: 'park',
                    parkId: a.parkId,
                    parkJobId: a.parkJobId,
                    assignmentMode: a.assignmentMode,
                    assignedByStaffId: a.assignedByStaffId,
                });
                return result.ok ? { ok: true } : { ok: false, code: result.code, message: result.message };
            },
            offerRideToDriver: (rideId, driverId, timeoutMs) => this.offerParkRideToDriver(rideId, driverId, timeoutMs),
            emitToRide: (rideId, event, payload) => { this.io.to(`ride:${rideId}`).emit(event, payload); },
            emitToPark: (parkId, event, payload) => { this.io.to(`park:${parkId}`).emit(event, payload); },
            emitToAdmin: (event, payload) => { this.io.to('admin').emit(event, payload); },
            notifyPassenger: (passengerId, title, body, data) => {
                void NotificationService.sendToUser(passengerId, UserRole.PASSENGER, title, body, data);
            },
        });

        RideActivityService.setPresenceProbe(async (role, userId) => {
            try {
                const sockets = await this.io.in(`${role}:${userId}`).fetchSockets();
                return sockets.length > 0;
            } catch {
                return false;
            }
        });

        this.setupHandlers();
    }

    private setupHandlers() {
        this.io.use((socket, next) => {
            const token = socket.handshake.auth?.token || socket.handshake.query?.token as string;
            if (!token) return next(new Error('Authentication required'));
            try {
                const decoded = jwt.verify(token, JWT_SECRET) as any;
                // A staff token must never authenticate as a customer. Staff
                // tokens are signed with a different secret so one normally
                // fails the verify above; this covers a deployment misconfigured
                // to share one secret, matching the guard in auth_middleware.
                if (decoded?.typ === 'staff' || decoded?.aud === 'keke-staff') {
                    return next(new Error('Invalid or expired token'));
                }
                (socket as any).user = decoded;
                return next();
            } catch {
                // Not a customer token. It may be a dispatcher device presenting
                // a STAFF token, which is signed with a different secret and
                // resolved against the database (status, credential version,
                // session) exactly as an HTTP request is.
                void StaffAuthService.identify(token)
                    .then((identity) => {
                        if (!identity) return next(new Error('Invalid or expired token'));
                        (socket as any).staff = identity;
                        return next();
                    })
                    .catch(() => next(new Error('Invalid or expired token')));
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

                // A PARK room carries live ride requests — pickup, destination,
                // passenger first name. Joining one is therefore authorised, not
                // merely namespaced: the socket must hold a STAFF identity that
                // is park-scoped to this park.
                //
                // Without this check any authenticated customer could join
                // `park:<uuid>` and watch every request a park receives.
                if (data.role === 'park') {
                    const staff = (socket as any).staff as { staffUserId: string } | undefined;
                    if (!staff) {
                        socket.emit('ride:error', { code: 'FORBIDDEN', message: 'Staff session required.' });
                        return;
                    }
                    const { staffMayActAtPark } = await import('../middleware/park_scope');
                    if (!(await staffMayActAtPark(staff.staffUserId, data.userId))) {
                        log.warn(`[SOCKET_BLOCK] ${staff.staffUserId} tried to join park ${data.userId} without scope`);
                        socket.emit('ride:error', { code: 'FORBIDDEN', message: 'You are not assigned to this park.' });
                        return;
                    }
                    socket.join(`park:${data.userId}`);
                    log.info(`park:${data.userId} joined by staff ${staff.staffUserId}`);
                    return;
                }

                // The OPS room carries every live ride request in the city —
                // passenger names, pickups, destinations. Same reasoning as the
                // park room above: joining it is authorised, not namespaced.
                // The socket must hold a staff identity that actually has
                // ops:queue_read, checked here rather than trusted from the
                // client, because the client is not a security boundary.
                if (data.role === 'ops') {
                    const staff = (socket as any).staff as { staffUserId: string } | undefined;
                    if (!staff) {
                        socket.emit('ride:error', { code: 'FORBIDDEN', message: 'Staff session required.' });
                        return;
                    }
                    try {
                        const { StaffAuthService } = await import('../services/staff_auth_service');
                        const { StaffUser } = await import('../models/StaffUser');
                        const member = await AppDataSource.getRepository(StaffUser)
                            .findOne({ where: { id: staff.staffUserId } });
                        const roles = await StaffAuthService.loadRoles(staff.staffUserId);
                        const perms = StaffAuthService.resolvePermissions(member?.status as any, roles);
                        if (!perms.has('ops:queue_read')) {
                            log.warn(`[SOCKET_BLOCK] ${staff.staffUserId} tried to join ops without permission`);
                            socket.emit('ride:error', { code: 'FORBIDDEN', message: 'You do not have Operations access.' });
                            return;
                        }
                    } catch (err: any) {
                        // Fails CLOSED. Unlike dispatch, being unable to verify
                        // authorisation for a feed of passenger data is a reason
                        // to refuse, not to proceed.
                        log.warn(`[SOCKET_BLOCK] ops permission check failed: ${err?.message}`);
                        socket.emit('ride:error', { code: 'FORBIDDEN', message: 'Could not verify Operations access.' });
                        return;
                    }
                    socket.join('ops');
                    log.info(`ops room joined by staff ${staff.staffUserId}`);
                    return;
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
                                // Contact fields are per-driver, so they are
                                // re-derived for THIS driver rather than replayed
                                // from the cached (contact-free) payload.
                                const contact = await this.offerContactFor(data.userId, payload.passengerId);
                                this.io.to(`driver:${data.userId}`).emit('ride:request', { ...payload, ...contact });
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

                /*
                 * Park presence, from the position the phone just reported.
                 *
                 * Deliberately after the dispatch update and deliberately not
                 * awaited into anything that can fail this handler: a driver's
                 * location reaching their passenger matters more than presence
                 * bookkeeping, and this must not be able to delay or break it.
                 * The service swallows its own errors and only ever touches
                 * smartphone drivers whose presence no human has set.
                 */
                void ParkAutoPresenceService.onHeartbeat(data.driverId, data.lat, data.lng);

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
                        // Structured locality, when the app resolved it. Null
                        // for older builds and for any pin the geocoder could
                        // not name — which is the honest record, and is why
                        // Ride Operations shows "Area not recorded" rather
                        // than guessing a neighbourhood from coordinates.
                        pickupSubLocality: request.pickupSubLocality ?? null,
                        pickupLocality: request.pickupLocality ?? null,
                        pickupCity: request.pickupCity ?? null,
                        pickupState: request.pickupState ?? null,
                        destinationSubLocality: request.destinationSubLocality ?? null,
                        destinationLocality: request.destinationLocality ?? null,
                        destinationCity: request.destinationCity ?? null,
                        destinationState: request.destinationState ?? null,
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
                // Operations sees every request the moment it exists. Detached
                // — the passenger's dispatch must not wait on a queue rebuild.
                OperationsBroadcastService.rideChanged(rideId, { isNewRequest: true });
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
                // Two people messaging each other are coordinating. That is the
                // strongest everyday evidence a delayed ride is still alive.
                void RideActivityService.record({
                    rideId: data.rideId,
                    type: RideActivityType.CHAT_MESSAGE,
                    kind: ActivityKind.INTENT,
                    by: data.senderRole as 'passenger' | 'driver',
                });
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

                    // Record WHY, not just that. History and the apps both need to
                    // tell a passenger changing their mind apart from a coordination
                    // outcome, and `status` alone cannot.
                    await rideRepo.update(data.rideId, {
                        status: 'canceled' as any,
                        completedAt: new Date(),
                        cancellationReason: 'passenger_cancelled',
                        outcomeReason: RideOutcomeCode.PASSENGER_CANCELLED,
                        cancelledByRole: CancelActorRole.PASSENGER,
                    } as any);

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
                    OperationsBroadcastService.rideChanged(data.rideId);
                    // `outcome` is the discriminator the apps key on. Without it the
                    // passenger app read EVERY cancellation as its own — including a
                    // driver-initiated one — and told the passenger they had
                    // cancelled a ride they had not.
                    this.broadcastToRide(data.rideId, 'ride:cancelled', {
                        rideId: data.rideId,
                        reason: 'passenger_cancelled',
                        outcome: 'cancelled_by_passenger',
                        eventId: coordinationEventId(data.rideId, 'cancelled', 'passenger_cancelled'),
                    });

                    // Notify the assigned driver directly (activeDispatches is cleared on accept)
                    if (ride.driverId) {
                        this.driverRideMap.delete(ride.driverId);
                        this.io.to(`driver:${ride.driverId}`).emit('ride:cancelled', {
                            rideId: data.rideId,
                            reason: 'passenger_cancelled',
                            outcome: 'cancelled_by_passenger',
                            title: 'Ride cancelled',
                            body: 'The passenger cancelled this ride. You can accept new rides now.',
                            eventId: coordinationEventId(data.rideId, 'cancelled', 'passenger_cancelled'),
                        });
                        NotificationService.sendToUser(ride.driverId, UserRole.DRIVER, 'Ride Cancelled', 'The passenger cancelled the ride.', {
                            type: 'RIDE_CANCELLED', rideId: data.rideId, intent: 'home',
                        });
                    }

                    // Dismiss any drivers still in the dispatch queue (searching phase)
                    const notifiedDrivers = this.activeDispatches.get(data.rideId);
                    if (notifiedDrivers) {
                        log.info(`[BACKEND_DISMISS] Signaling ${notifiedDrivers.size} drivers to dismiss ride ${data.rideId}`);
                        for (const driverId of notifiedDrivers) {
                            // A dismissal, not a cancellation of THEIR ride — these
                            // drivers were only being rung.
                            this.io.to(`driver:${driverId}`).emit('ride:cancelled', {
                                rideId: data.rideId, outcome: 'offer_withdrawn',
                            });
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
                    // A dispatcher must not be left working a request whose
                    // passenger has gone. No-op when no park job exists.
                    void ParkDispatchService.cancelForRide(data.rideId, 'passenger_cancelled');
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
            //
            // A thin shell around assignDriverToRide, which is the ONE place a
            // ride gains a driver. Park Dispatch calls the same method with
            // source:'park', so there is exactly one assignment path and one
            // ride lifecycle — a second flow would inevitably drift from this
            // one and produce rides that behave subtly differently.
            socket.on('ride:accept', async (raw) => {
                const data = validate(Schemas.rideAccept, raw, socket);
                if (!data) return;
                try {
                    // A driver accepting a PARK offer taps this same button. If
                    // a pending park assignment exists for this ride and driver,
                    // the acceptance is recorded as park-sourced — same button,
                    // same flow, correct provenance.
                    const parkContext = await ParkDispatchService.pendingContextFor(data.rideId, data.driverId);

                    const result = await this.assignDriverToRide({
                        rideId: data.rideId,
                        driverId: data.driverId,
                        source: parkContext ? 'park' : 'direct',
                        parkId: parkContext?.parkId ?? null,
                        parkJobId: parkContext?.jobId ?? null,
                        assignmentMode: parkContext ? 'electronic' : undefined,
                    });

                    if (!result.ok) {
                        // Failure codes map to the exact events the driver app
                        // has always received. Unchanged wire behaviour.
                        switch (result.code) {
                            case 'DRIVER_SUSPENDED':
                                socket.emit('error:suspended', { code: 'DRIVER_SUSPENDED', message: result.message });
                                return;
                            case 'DEBT_CASH_BLOCKED':
                                socket.emit('error:debt_blocked', { code: 'DEBT_CASH_BLOCKED', message: result.message });
                                return;
                            case 'RIDE_ALREADY_TAKEN':
                                socket.emit('ride:expired', { code: 'RIDE_ALREADY_TAKEN', rideId: data.rideId, message: result.message });
                                return;
                            default:
                                socket.emit('ride:error', { code: result.code, message: result.message });
                                return;
                        }
                    }

                    socket.emit('ride:confirmed', { rideId: data.rideId });

                    if (parkContext) {
                        // The ride row is already flipped; this closes the job
                        // and tells the dispatcher their driver said yes.
                        void ParkDispatchService.completePendingAssignment(data.rideId, data.driverId);
                    }
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

            // --- Meaningful interaction: proof the ride is still alive ---
            // Any deliberate action tells us two people are still coordinating.
            // Reported by the apps for things the server cannot see (a tel: call,
            // sharing live location), and recorded for the ones it can.
            socket.on('ride:activity', async (raw) => {
                const data = validate(Schemas.rideActivity, raw, socket);
                if (!data) return;
                try {
                    const ride = await AppDataSource.getRepository(Ride)
                        .findOne({ where: { rideId: data.rideId } });
                    if (!ride) return;
                    const belongs = (data.role === 'passenger' && ride.passengerId === data.userId)
                        || (data.role === 'driver' && ride.driverId === data.userId);
                    if (!belongs) return;

                    await RideActivityService.record({
                        rideId: data.rideId,
                        type: data.type as RideActivityType,
                        // Every action reported here is deliberate, so it extends
                        // the window. Liveness is inferred server-side instead.
                        kind: ActivityKind.INTENT,
                        by: data.role,
                        driverId: ride.driverId ?? null,
                    });
                    // Let the other side see it: "your driver is calling you" is
                    // far better than silence.
                    const notice = { rideId: data.rideId, by: data.role, type: data.type };
                    this.io.to(`ride:${data.rideId}`).emit('ride:activity_seen', notice);
                    if (ride.driverId) {
                        this.io.to(`driver:${ride.driverId}`).emit('ride:activity_seen', notice);
                    }
                } catch (err) {
                    log.error('ride:activity failed:', err);
                }
            });

            // --- One party ASKS to cancel; the other decides ---
            // Cancelling a ride two people are coordinating is a two-person act.
            // This records a request and hands the choice to the other side.
            socket.on('ride:cancel_request', async (raw) => {
                const data = validate(Schemas.rideCancelRequest, raw, socket);
                if (!data) return;
                try {
                    const rideRepo = AppDataSource.getRepository(Ride);
                    const ride = await rideRepo.findOne({ where: { rideId: data.rideId } });
                    if (!ride) {
                        socket.emit('ride:error', { code: 'RIDE_NOT_FOUND', message: 'Ride not found.' });
                        return;
                    }
                    const isPassenger = data.role === 'passenger' && ride.passengerId === data.userId;
                    const isDriver = data.role === 'driver' && ride.driverId === data.userId;
                    if (!isPassenger && !isDriver) {
                        socket.emit('ride:error', { code: 'FORBIDDEN', message: 'This ride is not yours.' });
                        return;
                    }
                    // A trip in progress is never cancelled this way — a real trip
                    // happened and a real fare is owed.
                    if (!['accepted', 'arrived'].includes(ride.status as unknown as string)) {
                        socket.emit('ride:error', { code: 'INVALID_STATE', message: 'This ride can no longer be cancelled here.' });
                        return;
                    }

                    const requestClaimedAt = new Date();
                    const claim = await rideRepo
                        .createQueryBuilder()
                        .update()
                        .set({
                            cancellationRequestedBy: data.role,
                            cancellationRequestedAt: requestClaimedAt,
                            cancellationRequestState: 'pending',
                            delayState: RideDelayState.CANCELLATION_REQUESTED,
                        })
                        .where(`"rideId" = :rideId AND "completedAt" IS NULL
                                AND ("cancellationRequestState" IS NULL OR "cancellationRequestState" != 'pending')`,
                            { rideId: data.rideId })
                        .execute();
                    if (!claim.affected) {
                        socket.emit('ride:cancel_request_ack', {
                            rideId: data.rideId, accepted: false, reason: 'request_already_pending',
                        });
                        return;
                    }

                    const other = data.role === 'passenger' ? 'driver' : 'passenger';
                    const cfg = loadStaleRideConfig();
                    // Absolute deadline, not just a duration. An app that restarts
                    // mid-window has to resume the countdown where it actually is;
                    // given only "3 minutes" it would restart from three.
                    const requestedAt = requestClaimedAt;
                    const respondByAt = new Date(requestedAt.getTime() + cfg.decisionWindowMinutes * 60_000);
                    const payload = {
                        rideId: data.rideId,
                        eventId: coordinationEventId(data.rideId, `cancel_request_${data.role}`, requestedAt.getTime()),
                        rideStatus: ride.status,
                        requestedBy: data.role,
                        respondWithinMinutes: cfg.decisionWindowMinutes,
                        respondByAt: respondByAt.toISOString(),
                        respondBySeconds: cfg.decisionWindowMinutes * 60,
                        actions: ['accept_cancellation', 'continue_ride'],
                    };
                    if (other === 'driver' && ride.driverId) {
                        this.io.to(`driver:${ride.driverId}`).emit('ride:cancel_requested', {
                            ...payload,
                            title: 'Passenger would like to cancel this ride',
                            body: 'You can accept the cancellation, or let them know you are still coming.',
                        });
                        await NotificationService.sendToUser(
                            ride.driverId, UserRole.DRIVER,
                            'Passenger wants to cancel',
                            'Accept the cancellation, or tell them you are still on your way.',
                            { type: 'CANCELLATION_REQUESTED', rideId: data.rideId, intent: 'active', eventId: payload.eventId },
                        );
                    } else {
                        this.io.to(`ride:${data.rideId}`).emit('ride:cancel_requested', {
                            ...payload,
                            title: 'Your driver would like to cancel this ride',
                            body: 'You can accept, or ask them to keep coming.',
                        });
                        if (ride.passengerId) {
                            await NotificationService.sendToUser(
                                ride.passengerId, UserRole.PASSENGER,
                                'Your driver wants to cancel',
                                'Accept the cancellation, or ask them to keep coming.',
                                { type: 'CANCELLATION_REQUESTED', rideId: data.rideId, intent: 'active', eventId: payload.eventId },
                            );
                        }
                    }
                    socket.emit('ride:cancel_request_ack', {
                        rideId: data.rideId, accepted: true, awaiting: other,
                        respondByAt: payload.respondByAt, eventId: payload.eventId,
                    });

                    DispatchMonitorService.record({
                        rideId: data.rideId,
                        eventType: DispatchEventType.CANCELLATION_REQUESTED,
                        driverId: ride.driverId ?? null,
                        detail: { requestedBy: data.role, awaiting: other, rideStatus: ride.status },
                    });
                } catch (err) {
                    log.error('ride:cancel_request failed:', err);
                    socket.emit('ride:error', { code: 'INTERNAL_ERROR', message: 'Could not send your request. Please try again.' });
                }
            });

            // --- The other party answers a cancellation request ---
            socket.on('ride:cancel_response', async (raw) => {
                const data = validate(Schemas.rideCancelResponse, raw, socket);
                if (!data) return;
                try {
                    const rideRepo = AppDataSource.getRepository(Ride);
                    const ride = await rideRepo.findOne({ where: { rideId: data.rideId } });
                    if (!ride) return;
                    const isPassenger = data.role === 'passenger' && ride.passengerId === data.userId;
                    const isDriver = data.role === 'driver' && ride.driverId === data.userId;
                    if (!isPassenger && !isDriver) {
                        socket.emit('ride:error', { code: 'FORBIDDEN', message: 'This ride is not yours.' });
                        return;
                    }
                    if (ride.cancellationRequestState !== 'pending') {
                        socket.emit('ride:error', { code: 'INVALID_STATE', message: 'There is no pending request on this ride.' });
                        return;
                    }
                    // The requester cannot also answer their own request.
                    if (ride.cancellationRequestedBy === data.role) {
                        socket.emit('ride:error', { code: 'FORBIDDEN', message: 'You made this request.' });
                        return;
                    }

                    const requester = ride.cancellationRequestedBy as 'passenger' | 'driver';

                    if (data.decision === 'accept') {
                        await rideRepo.update(data.rideId, { cancellationRequestState: 'accepted' } as any);
                        const resolution = requester === 'passenger'
                            ? StaleResolution.CANCELLED_BY_MUTUAL_AGREEMENT_PASSENGER_INITIATED
                            : StaleResolution.CANCELLED_BY_MUTUAL_AGREEMENT_DRIVER_INITIATED;
                        const outcome = await RideCleanupService.terminate({
                            rideId: data.rideId,
                            reason: resolution,
                            situation: (ride.staleReason as string) ?? undefined,
                            expectedStatuses: ['accepted', 'arrived'],
                            passengerMessage: 'This ride has been cancelled by agreement. You can book again now.',
                            driverMessage: 'This ride has been cancelled by agreement. You can accept new rides now.',
                            // Both parties took part, which is the whole point of
                            // the guard — so it is satisfied by construction here.
                            requireDecisionPrompt: false,
                        });
                        DispatchMonitorService.record({
                            rideId: data.rideId,
                            eventType: DispatchEventType.CANCELLATION_REQUEST_ACCEPTED,
                            driverId: ride.driverId ?? null,
                            detail: { requestedBy: requester, acceptedBy: data.role, applied: outcome.applied },
                        });
                        socket.emit('ride:cancel_response_ack', { rideId: data.rideId, decision: 'accept', applied: outcome.applied });
                        return;
                    }

                    // decision === 'continue' — the ride goes on. Clear the request
                    // and count it as activity, because it plainly is.
                    await rideRepo
                        .createQueryBuilder()
                        .update()
                        .set({
                            cancellationRequestState: 'declined',
                            delayState: data.role === 'driver'
                                ? RideDelayState.DRIVER_CONFIRMED_EN_ROUTE
                                : RideDelayState.PASSENGER_WAITING,
                            staleDecisionBy: data.role,
                            staleDecisionChoice: 'wait',
                            staleDecisionAt: new Date(),
                        })
                        .where('"rideId" = :rideId AND "completedAt" IS NULL', { rideId: data.rideId })
                        .execute();

                    await RideActivityService.record({
                        rideId: data.rideId,
                        type: data.role === 'driver'
                            ? RideActivityType.DRIVER_STILL_COMING
                            : RideActivityType.PASSENGER_KEEP_WAITING,
                        kind: ActivityKind.INTENT,
                        by: data.role,
                        driverId: ride.driverId ?? null,
                        detail: { declinedCancellationFrom: requester },
                    });

                    const notice = {
                        rideId: data.rideId,
                        eventId: coordinationEventId(data.rideId, 'cancel_declined', data.role),
                        rideStatus: ride.status,
                        declinedBy: data.role,
                        title: data.role === 'driver' ? 'Your driver is continuing' : 'Your passenger is still coming',
                        body: data.role === 'driver'
                            ? 'They have asked to keep the ride and are still on their way.'
                            : 'They would like to keep the ride.',
                    };
                    this.io.to(`ride:${data.rideId}`).emit('ride:cancel_declined', notice);
                    if (ride.driverId) {
                        this.io.to(`driver:${ride.driverId}`).emit('ride:cancel_declined', notice);
                    }
                    socket.emit('ride:cancel_response_ack', { rideId: data.rideId, decision: 'continue', applied: true });

                    DispatchMonitorService.record({
                        rideId: data.rideId,
                        eventType: DispatchEventType.CANCELLATION_REQUEST_DECLINED,
                        driverId: ride.driverId ?? null,
                        detail: { requestedBy: requester, declinedBy: data.role },
                    });
                } catch (err) {
                    log.error('ride:cancel_response failed:', err);
                    socket.emit('ride:error', { code: 'INTERNAL_ERROR', message: 'Could not record your answer. Please try again.' });
                }
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
                        // A cancel CHOICE at a decision prompt is treated as a
                        // request the other party still gets to answer — see
                        // ride:cancel_request. Reaching here means the other side
                        // already accepted, or the request went unanswered.
                        const resolution = data.role === 'passenger'
                            ? StaleResolution.CANCELLED_BY_MUTUAL_AGREEMENT_PASSENGER_INITIATED
                            : StaleResolution.CANCELLED_BY_MUTUAL_AGREEMENT_DRIVER_INITIATED;
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
                // A decline on a PARK offer hands the request straight back to
                // the dispatcher, who picks somebody else. The passenger is
                // never told — from their side the search simply continues.
                void ParkDispatchService.handleDriverDecline(data.rideId, data.driverId, 'driver_declined');
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
                    // ARRIVAL CHANGES EVERYTHING. The driver-delayed story is over.
                    // Clear every trace of it and start measuring the passenger's
                    // wait instead — a completely different workflow, with the
                    // driver now the one who is present and waiting.
                    await AppDataSource.getRepository(Ride)
                        .createQueryBuilder()
                        .update()
                        .set({
                            delayState: RideDelayState.WAITING_FOR_PASSENGER,
                            staleWarnedAt: null,
                            staleDecisionPromptedAt: null,
                            staleDecisionDeadlineAt: null,
                            staleDecisionBy: null,
                            staleDecisionChoice: null,
                            staleDecisionRound: 0,
                            staleDeadlineOverrideAt: null,
                            lastReminderAt: null,
                            cancellationRequestState: null,
                            cancellationRequestedBy: null,
                            cancellationRequestedAt: null,
                        })
                        .where('"rideId" = :rideId', { rideId: data.rideId })
                        .execute();
                    await RideActivityService.record({
                        rideId: data.rideId,
                        type: RideActivityType.DRIVER_ARRIVED,
                        kind: ActivityKind.INTENT,
                        by: 'driver',
                        driverId: data.driverId,
                    });
                    await RideActivityService.clearApproach(data.rideId);

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
                    // TRIP STARTED. All accepted/arrived coordination logic is now
                    // irrelevant and must not run again for this ride — from here
                    // only trip-level monitoring applies (lost GPS, abandoned trip),
                    // and those are flagged for humans, never auto-cancelled.
                    await AppDataSource.getRepository(Ride)
                        .createQueryBuilder()
                        .update()
                        .set({
                            delayState: RideDelayState.NONE,
                            staleWarnedAt: null,
                            staleDecisionPromptedAt: null,
                            staleDecisionDeadlineAt: null,
                            staleDecisionBy: null,
                            staleDecisionChoice: null,
                            staleDeadlineOverrideAt: null,
                            lastReminderAt: null,
                            cancellationRequestState: null,
                            cancellationRequestedBy: null,
                            cancellationRequestedAt: null,
                        })
                        .where('"rideId" = :rideId', { rideId: data.rideId })
                        .execute();
                    await RideActivityService.clearApproach(data.rideId);

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

            isDispatchPaused: async (id: string) => {
                try {
                    return RideControlService.isOperationsControlled(await RideControlService.get(id));
                } catch (err: any) {
                    // Fails OPEN. A database blip must not stop dispatch: a
                    // passenger with no Keke is a worse outcome than a
                    // dispatcher being interrupted by an automatic offer.
                    log.warn(`[OPS_CONTROL] pause check failed for ${id}: ${err?.message}`);
                    return false;
                }
            },

            sendOffer: async (driverId: string, round: number): Promise<OfferDelivery> => {
                // Enrich once per offer so a re-offered driver still gets the
                // current pickup code. The cached copy is contact-free; contact
                // fields are merged per driver just before the emit below.
                const base = await this.buildOfferPayload(rideId, payload, round);
                this.dispatchPayloads.set(rideId, base);
                const enriched = { ...base, ...(await this.offerContactFor(driverId, payload.passengerId)) };

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
     * THE one place a ride LOSES its driver without the ride ending.
     *
     * The mirror of assignDriverToRide, and deliberately built the same way:
     * a single conditional UPDATE is the arbiter, and everything else is
     * cleanup that runs only after it has already won.
     *
     *     UPDATE ride SET driverId = NULL, status = 'searching'
     *      WHERE rideId = ? AND status IN ('accepted','arrived') AND driverId = ?
     *
     * That WHERE clause is what makes every race safe:
     *   - the driver started the trip a moment ago  → status is in_progress,
     *     affected = 0, and Operations is told the trip has begun
     *   - the passenger cancelled                    → status is canceled, 0
     *   - another operator released first            → driverId is null, 0
     *   - the ride was never this driver's           → driverId mismatch, 0
     *
     * The ride stays ALIVE and keeps its rideId. The passenger is not sent back
     * to "Where to?" and no second ride is created — the whole point is that
     * this is the same journey with a different Keke.
     */
    private async releaseAssignedDriver(args: {
        rideId: string;
        expectedDriverId: string;
        reason: string;
        releasedByStaffId?: string | null;
    }): Promise<
        | { ok: true; driverId: string; priorStatus: string; priorEvidence: Record<string, unknown> }
        | { ok: false; code: string; message: string }
    > {
        const { rideId, expectedDriverId } = args;
        const rideRepo = AppDataSource.getRepository(Ride);
        const before = await rideRepo.findOne({ where: { rideId } });
        if (!before) return { ok: false, code: 'RIDE_NOT_FOUND', message: 'Ride not found.' };

        // Said plainly before the UPDATE so the operator gets the right
        // sentence. The UPDATE would refuse anyway — this only shapes the
        // message, exactly as in the assignment path.
        const status = String(before.status);
        if (status === 'in_progress' || status === 'started') {
            return {
                ok: false,
                code: 'TRIP_ALREADY_STARTED',
                message: 'This trip has already started. Use the incident/cancellation workflow instead.',
            };
        }
        if (!['accepted', 'arrived'].includes(status)) {
            return {
                ok: false,
                code: 'NOT_REASSIGNABLE',
                message: `This ride is ${status} and cannot be reassigned.`,
            };
        }

        // Driver A's own journey evidence. Cleared from the ride so Driver B
        // does not inherit an arrival that was not theirs, but carried out of
        // here so the intervention record keeps it — a driver who genuinely
        // reached the pickup and then could not take the trip is a fact worth
        // keeping.
        const priorEvidence = {
            acceptedAt: before.acceptedAt ?? null,
            arrivedAt: before.arrivedAt ?? null,
            arrivedPickupDistanceM: before.arrivedPickupDistanceM ?? null,
        };

        const update = await rideRepo
            .createQueryBuilder()
            .update()
            .set({
                driverId: null as any,
                status: 'searching' as any,
                acceptedAt: null,
                acceptLat: null,
                acceptLng: null,
                arrivedAt: null,
                arrivedLat: null,
                arrivedLng: null,
                arrivedPickupDistanceM: null,
            })
            .where('"rideId" = :rideId AND status IN (:...allowed) AND "driverId" = :driverId', {
                rideId,
                allowed: ['accepted', 'arrived'],
                driverId: expectedDriverId,
            })
            .execute();

        if (!update.affected) {
            const now = await rideRepo.findOne({ where: { rideId } });
            const nowStatus = String(now?.status ?? 'unknown');
            return {
                ok: false,
                code: nowStatus === 'in_progress' || nowStatus === 'started'
                    ? 'TRIP_ALREADY_STARTED'
                    : 'RIDE_STATE_CHANGED',
                message: nowStatus === 'in_progress' || nowStatus === 'started'
                    ? 'This trip has already started. Use the incident/cancellation workflow instead.'
                    : 'This ride changed while you were working on it. Reload and try again.',
            };
        }

        // ── Cleanup, only now that the release has committed ────────────
        // Exclude first: the ride is already `searching` again, so this is the
        // narrow window in which the released driver could re-accept.
        const excluded = this.rideExclusions.get(rideId) ?? new Set<string>();
        excluded.add(expectedDriverId);
        this.rideExclusions.set(rideId, excluded);

        this.driverRideMap.delete(expectedDriverId);
        try { await DispatchService.releaseDriver(expectedDriverId, rideId); } catch { /* best effort */ }
        // The assignment lock is what isRideAssigned reads. Left in place, the
        // orchestrator would treat the ride as still owned.
        try { await redis.del(`ride:${rideId}:lock`); } catch { /* best effort */ }

        // Tell Driver A, so their app clears rather than showing a ride that is
        // no longer theirs — and so a reconnect does not restore it.
        this.io.to(`driver:${expectedDriverId}`).emit('ride:cancelled', {
            rideId,
            reason: 'reassigned_by_operations',
            message: 'This ride has been reassigned. You can accept new rides now.',
        });
        NotificationService.sendToUser(
            expectedDriverId,
            UserRole.DRIVER,
            'Ride reassigned',
            'That ride has been given to another driver. You are free to accept new rides.',
            { rideId, type: 'RIDE_REASSIGNED' },
        );

        // The passenger keeps the SAME ride and the same screen. This is a
        // status line, not a lifecycle change.
        this.io.to(`ride:${rideId}`).emit('ride:reassigning', {
            rideId,
            message: "We're assigning another driver",
        });
        this.io.to('admin').emit('ride:status_update', { rideId, status: 'searching' });

        rlog('operations_driver_released', {
            rideId,
            priorStatus: status,
            reason: args.reason,
            byStaffId: args.releasedByStaffId ?? null,
        });

        return { ok: true, driverId: expectedDriverId, priorStatus: status, priorEvidence };
    }

    /**
     * THE one place a ride gains a driver.
     *
     * Extracted verbatim from the original `ride:accept` handler so that Park
     * Dispatch assigns through the identical path rather than a parallel one.
     * The order of operations, the atomic UPDATE, the evidence capture, the
     * events emitted and the state cleanup are all unchanged — only the shape
     * of the result changed, from socket emits to a returned value the caller
     * presents.
     *
     * Two callers:
     *   source 'direct' — a smartphone driver tapped accept. Identical to
     *                     before in every observable respect.
     *   source 'park'   — a dispatcher assigned a driver at a park. Same
     *                     lifecycle from this moment on: the ride is
     *                     `accepted`, owned by the driver, and every later
     *                     transition runs through the existing handlers.
     *
     * The conditional `WHERE status = 'searching'` remains the SOLE arbiter of
     * who owns a ride. A direct acceptance racing a park assignment therefore
     * cannot both win — one gets affected=1, the other is told the ride is gone.
     */
    private async assignDriverToRide(args: {
        rideId: string;
        driverId: string;
        source: 'direct' | 'park' | 'operations';
        parkId?: string | null;
        parkJobId?: string | null;
        assignmentMode?: 'electronic' | 'verbal';
        /** Staff member who performed a park assignment, for the dispatch trail. */
        assignedByStaffId?: string | null;
    }): Promise<
        | { ok: true; ride: any; driverDetails: Record<string, unknown> }
        | { ok: false; code: string; message: string }
    > {
        const { rideId, driverId } = args;

        // A driver Operations has just RELEASED from this ride must not be able
        // to take it straight back. Release returns the ride to `searching`, so
        // without this a stale client that still shows the offer could re-accept
        // in the gap before Operations assigns somebody else — and the operator
        // who just heard "I can't take it" would watch the same driver reappear.
        //
        // Direct acceptance only. Operations may deliberately re-assign the same
        // driver (he rang back, he can take it after all), and Park assignment
        // is a dispatcher's decision too.
        if (args.source === 'direct' && this.rideExclusions.get(rideId)?.has(driverId)) {
            return { ok: false, code: 'RIDE_ALREADY_TAKEN', message: 'This ride is no longer available.' };
        }

        const profile = await AppDataSource.getRepository(DriverProfile).findOneBy({ userId: driverId });
        if (!profile || profile.status === 'suspended' || profile.status === 'rejected') {
            log.warn(`[SOCKET_BLOCK] Ride acceptance blocked for driver ${driverId} (Status: ${profile?.status})`);
            return { ok: false, code: 'DRIVER_SUSPENDED', message: 'Your account access is restricted. Please contact support.' };
        }

        // Debt gate for cash rides
        const ride = await AppDataSource.getRepository(Ride).findOne({ where: { rideId } });
        if (ride?.paymentMode === 'cash') {
            const debt = await WalletService.getDriverDebt(driverId);
            if (debt >= DEBT_CASH_BLOCK) {
                log.warn(`[DEBT_BLOCK] Cash ride blocked for driver ${driverId} — debt ₦${debt}`);
                return {
                    ok: false,
                    code: 'DEBT_CASH_BLOCKED',
                    message: 'You cannot accept cash rides until your outstanding balance is cleared. Go to your wallet to pay.',
                };
            }
        }

        // Prevent double-assignment: a driver already on an active ride
        // cannot accept another until they finish/cancel the current one.
        const activeForDriver = await AppDataSource.getRepository(Ride).findOne({
            where: { driverId, status: In(['accepted', 'arrived', 'in_progress'] as any[]) },
        });
        if (activeForDriver && activeForDriver.rideId !== rideId) {
            return { ok: false, code: 'ALREADY_ON_RIDE', message: 'Finish your current ride before accepting a new one.' };
        }

        // Atomic UPDATE: claims the ride only if still 'searching'.
        // PostgreSQL row-level locking makes this race-condition-free —
        // no two drivers can both get affected=1 for the same row.
        const rideRepo = AppDataSource.getRepository(Ride);
        const updateResult = await rideRepo
            .createQueryBuilder()
            .update()
            .set({
                driverId,
                status: 'accepted' as any,
                // Provenance, written in the SAME statement that claims the
                // ride so a park-assigned ride can never exist without its
                // park recorded. Null for direct, which is every ride today.
                ...(args.source === 'park'
                    ? {
                        dispatchMode: 'park',
                        parkId: args.parkId ?? null,
                        parkJobId: args.parkJobId ?? null,
                        assignmentMode: args.assignmentMode ?? 'electronic',
                    }
                    : {}),
            } as any)
            .where('"rideId" = :rideId AND status = :status', { rideId, status: 'searching' })
            .returning('*')
            .execute();

        if (!updateResult.affected || updateResult.affected === 0) {
            return { ok: false, code: 'RIDE_ALREADY_TAKEN', message: 'This ride is no longer available.' };
        }

        const currentRide = updateResult.raw[0];

        // Signal the dispatch loop to stop polling
        await redis.set(`ride:${rideId}:lock`, driverId);

        // Control is meaningless once a driver owns the ride, so it returns to
        // AUTO here — for EVERY source, not just Operations. A driver accepting
        // automatically while a dispatcher held control must also end that
        // control, or the dispatcher would keep a lease on a ride that is
        // already under way. Never throws; the assignment has already
        // committed and bookkeeping must not undo it.
        await RideControlService.releaseOnAssignment(rideId);

        this.driverRideMap.set(driverId, rideId);

        // Anti-fraud evidence: record where the driver was when they
        // accepted (no gate here — accepting while stationary is normal).
        //
        // A feature-phone driver has no GPS at all, so this is legitimately
        // null for them. That absence is explained by ride.assignmentMode
        // ('verbal'), NOT inferred — a null fix on a smartphone ride still
        // means something went wrong.
        try {
            const acceptLoc = await getDriverLiveLocation(driverId);
            await rideRepo.update(rideId, {
                acceptedAt: new Date(),
                acceptLat: acceptLoc?.lat ?? null,
                acceptLng: acceptLoc?.lng ?? null,
            } as any);
        } catch (e: any) {
            log.warn(`[INTEGRITY] accept evidence capture failed for ${rideId}: ${e?.message}`);
        }

        const driverUser = await AppDataSource.getRepository(User).findOne({ where: { id: driverId } });

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

        this.broadcastToRide(rideId, 'ride:assigned', {
            driverId,
            driverDetails,
            pickupCode: ride?.pickupCode ?? null,
            // Additive fields. Older passenger builds ignore them and render
            // the driver card exactly as they do for a direct ride — which is
            // the intent: the passenger must not be able to tell, and must not
            // care, which supply channel found their Keke.
            ...(args.source === 'park'
                ? { dispatchMode: 'park', assignmentMode: args.assignmentMode ?? 'electronic' }
                : {}),
        });

        NotificationService.sendToUser(currentRide.passengerId || currentRide.passengerId, UserRole.PASSENGER, 'Driver Assigned!', 'A driver is on the way to you.', {
            type: 'RIDE_ASSIGNED', rideId, intent: 'active',
        });
        this.io.to('admin').emit('ride:status_update', { rideId, status: 'accepted' });

        // A park-assigned SMARTPHONE driver still needs to be told in their app.
        // The direct path emits ride:confirmed on the accepting socket; here the
        // driver was not the one who acted, so it goes to their room.
        if (args.source === 'park') {
            this.io.to(`driver:${driverId}`).emit('ride:confirmed', { rideId });
            this.io.to(`driver:${driverId}`).emit('ride:park_assignment', {
                rideId,
                parkId: args.parkId ?? null,
                assignmentMode: args.assignmentMode ?? 'electronic',
                pickupAddress: currentRide?.pickupAddress ?? null,
                destinationAddress: currentRide?.destinationAddress ?? null,
                fare: currentRide?.fare ?? null,
                paymentMode: currentRide?.paymentMode ?? null,
                pickupCode: ride?.pickupCode ?? null,
            });
        }

        // Reservation → assignment. The atomic DB UPDATE above (status
        // searching→accepted) is the true arbiter and is retained; here we
        // just confirm/log ownership and release ALL of this ride's ring
        // reservations. The accepted driver is now excluded from future
        // dispatch by DB status='accepted' + driverRideMap, so releasing is
        // race-safe (the DB row was flipped before this release).
        const resOwner = await DispatchService.getReservationOwner(driverId);
        rlog('assign', { rideId, driverId, reservationOwner: resOwner, ownershipMatched: resOwner === rideId, source: args.source });
        // Stop ALL dispatch activity for this ride immediately — the
        // in-flight offer window is abandoned rather than run out, and
        // no further round can start.
        const acceptedRun = this.dispatchRuns.get(rideId);
        if (acceptedRun) {
            acceptedRun.noteAcceptance(driverId);
            rlog('acceptance', {
                rideId,
                driverId,
                dispatchRound: acceptedRun.evidence.round,
                summary: acceptedRun.evidence.summary(false),
            });
        }
        DispatchMonitorService.record({
            rideId,
            eventType: args.source === 'park'
                ? DispatchEventType.PARK_DRIVER_ASSIGNED
                : DispatchEventType.DRIVER_ACCEPTED,
            dispatchRound: acceptedRun?.evidence.round ?? null,
            driverId,
            detail: {
                // Time from request creation to assignment.
                timeToAssignmentMs: currentRide?.createdAt
                    ? Date.now() - new Date(currentRide.createdAt).getTime()
                    : null,
                ...(args.source === 'park'
                    ? {
                        parkId: args.parkId ?? null,
                        assignmentMode: args.assignmentMode ?? 'electronic',
                        assignedByStaffId: args.assignedByStaffId ?? null,
                    }
                    : {}),
            },
            withFreshness: true,
        });
        this.clearDispatchTimers(rideId);
        await this.releaseRideReservations(rideId, 'assigned');
        this.rideExclusions.delete(rideId);
        this.clearDispatch(rideId);

        // A direct driver who accepted during the park phase has just won the
        // conditional UPDATE. The park's queue must lose the request rather
        // than leave a dispatcher working a ride that already has a driver.
        if (args.source === 'direct') {
            void ParkDispatchService.cancelForRide(rideId, 'taken_by_direct_driver');
        }

        return { ok: true, ride: currentRide, driverDetails };
    }

    /**
     * Put a park assignment on a smartphone driver's device.
     *
     * Deliberately reuses `ride:request` — the SAME event the driver app has
     * always rendered for direct dispatch, with the same card, countdown, ring
     * and Accept/Decline buttons. A park offer therefore needs no driver app
     * change at all, and a driver does not have to learn a second way of being
     * offered work.
     *
     * Returns whether any transport carried it. A driver whose phone is
     * unreachable is handed straight back to the dispatcher rather than having
     * the window burned on an offer nobody will see.
     */
    private async offerParkRideToDriver(rideId: string, driverId: string, timeoutMs: number): Promise<boolean> {
        try {
            const ride = await AppDataSource.getRepository(Ride).findOne({ where: { rideId } });
            if (!ride) return false;

            const payload = {
                rideId,
                passengerId: ride.passengerId,
                fare: Number(ride.fare),
                isCash: ride.paymentMode === 'cash',
                pickupLat: ride.pickupLat != null ? Number(ride.pickupLat) : null,
                pickupLng: ride.pickupLng != null ? Number(ride.pickupLng) : null,
                destinationLat: ride.destinationLat != null ? Number(ride.destinationLat) : null,
                destinationLng: ride.destinationLng != null ? Number(ride.destinationLng) : null,
                pickupAddress: ride.pickupAddress ?? null,
                destinationAddress: ride.destinationAddress ?? null,
                pickupCode: ride.pickupCode ?? null,
                estimatedDistanceM: ride.estimatedDistanceM ?? null,
                estimatedDurationSec: ride.estimatedDurationSec ?? null,
                // Additive. Newer builds can label the card "from your park";
                // older ones ignore it and show an ordinary request.
                dispatchSource: 'park',
                offerTimeoutMs: timeoutMs,
                // Contact shaping goes through the same privacy layer as a
                // direct offer — a park offer must not become a way around it.
                ...(await this.offerContactFor(driverId, ride.passengerId)),
            };

            let socketDelivered = false;
            try {
                const sockets = await this.io.in(`driver:${driverId}`).fetchSockets();
                socketDelivered = sockets.length > 0;
            } catch {
                /* presence check failure is not delivery failure */
            }
            this.io.to(`driver:${driverId}`).emit('ride:request', payload);

            let pushSuccessCount = 0;
            try {
                const push = await NotificationService.sendToUser(
                    driverId,
                    UserRole.DRIVER,
                    'Ride From Your Park',
                    'The dispatcher has a ride for you — tap to accept.',
                    { type: 'NEW_REQUEST', rideId, intent: 'booking', dispatchSource: 'park' },
                );
                pushSuccessCount = push.successCount;
            } catch {
                /* the socket may still have carried it */
            }

            const delivered = socketDelivered || pushSuccessCount > 0;
            rlog('park_offer_delivery', { rideId, driverId, socketDelivered, pushSuccessCount, delivered });
            DispatchMonitorService.record({
                rideId,
                eventType: DispatchEventType.PARK_DRIVER_OFFERED,
                driverId,
                detail: { socketDelivered, pushSuccessCount, timeoutMs },
                withFreshness: true,
            });
            return delivered;
        } catch (err: any) {
            log.error(`[PARK_OFFER] delivery failed for ${rideId}/${driverId}: ${err?.message}`);
            return false;
        }
    }

    /**
     * Fan one orchestrator log event out to the durable admin trail.
     * The mapping itself lives in dispatch_event_projection.ts so it can be
     * tested directly and audited in one place.
     */
    private projectDispatchEvent(rideId: string, event: string, fields: Record<string, any>): void {
        // The kill switch is checked here rather than inside the recorder so
        // that turning telemetry off also skips the mapping work, not just the
        // write. Synchronous and cached — see RideOperationsSwitch — so this
        // costs a clock read on the dispatch path and nothing else.
        if (!RideOperationsSwitch.isEnabled()) return;

        // Belt and braces. `record` already swallows its own errors, but the
        // mapping runs first and a malformed log field must not be able to
        // throw into the orchestrator's log port — which is called from inside
        // the offer loop, between a passenger and a driver.
        try {
            for (const row of projectDispatchEvent(rideId, event, fields)) {
                DispatchMonitorService.record(row);
            }
        } catch (err: any) {
            console.warn(`[RIDE_OPS] projection failed (${event}): ${err?.message}`);
        }
    }

    /**
     * Offer payload for a driver: the request plus per-ride enrichment.
     *
     * Deliberately contains NO passenger contact data. Contact is per-DRIVER
     * (it depends on that driver's app version and the configured privacy mode)
     * whereas this payload is per-RIDE and gets cached in dispatchPayloads for
     * reconnect recovery. Mixing the two would let a cached payload deliver one
     * driver's contact variant to a different driver.
     * See offerContactFor and services/contact_access_service.ts.
     */
    private async buildOfferPayload(rideId: string, payload: any, round: number): Promise<any> {
        const rideRecord = await AppDataSource.getRepository(Ride).findOne({ where: { rideId } });
        return {
            ...payload,
            pickupCode: rideRecord?.pickupCode ?? null,
            dispatchRound: round,
        };
    }

    /**
     * Passenger contact fields for ONE candidate driver's offer.
     *
     * @deprecated Sending contact details with an offer — to drivers who have
     *   not accepted and may never — is the privacy defect recorded in
     *   docs/contact_privacy_migration.md. The default mode (`legacy`) still
     *   sends the full number so installed apps keep working; once the fleet has
     *   moved to GET /rides/:rideId/contact, CONTACT_PRIVACY_MODE goes to
     *   `strict` and this method returns nothing.
     */
    private async offerContactFor(driverId: string, passengerId?: string | null): Promise<Record<string, unknown>> {
        try {
            const passengerUser = passengerId
                ? await AppDataSource.getRepository(User).findOne({ where: { id: passengerId } })
                : null;
            return await ContactAccessService.offerContactFields(driverId, passengerUser);
        } catch (err: any) {
            log.warn(`[CONTACT_PRIVACY] offer contact shaping failed: ${err?.message}`);
            // Fail CLOSED: an error here withholds a phone number, it never
            // leaks one.
            return { passengerPhone: null };
        }
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
            // `operations_control` joins the exclusions: a dispatcher taking
            // over must never mark the ride failed. The passenger is still
            // waiting and a human is actively working on it.
            if (
                result &&
                result.stopReason !== 'accepted' &&
                result.stopReason !== 'assigned_elsewhere' &&
                result.stopReason !== 'operations_control'
            ) {
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

        // ── PARK DISPATCH FALLBACK ───────────────────────────────────────
        // The ONE point where park dispatch touches the dispatch path, and it
        // is downstream of everything: the run has finished, its rounds are
        // exhausted, its evidence is sealed. Nothing below can influence which
        // drivers were rung or how long they were given.
        //
        // Disabled by default (PARK_DISPATCH_ENABLED). When disabled, or when
        // no park takes the ride, execution continues to the exact `failed`
        // path this method has always taken. offerToPark never throws — it
        // catches its own errors and returns false — so a fault in the fallback
        // degrades to today's behaviour rather than breaking dispatch.
        try {
            if (await ParkDispatchService.offerToPark(rideId)) {
                rlog('park_fallback_engaged', {
                    rideId,
                    stopReason: result.stopReason,
                    directOutcome: outcome.code,
                });
                // The ride stays `searching` and is now the park's problem. The
                // passenger's active-ride slot is deliberately NOT released:
                // they still have one ride in flight.
                return;
            }
        } catch (err: any) {
            log.error(JSON.stringify({ level: 'error', event: 'park_fallback_threw', rideId, error: err?.message }));
        }

        // The outcome code is written in the SAME update as the status it
        // explains. It is not telemetry and is deliberately not behind the
        // telemetry kill switch: a `failed` row with no reason is exactly the
        // defect this work exists to remove, and it must not be able to come
        // back because someone silenced the event trail.
        const failureOutcome = outcomeFromDispatchCode(outcome.code) ?? RideOutcomeCode.TECHNICAL_FAILURE;
        await rideRepo.update(rideId, {
            status: 'failed' as any,
            outcomeReason: failureOutcome,
            outcomeDetail: outcome.dispatchResult ?? null,
        });

        // Only the codes an automation actually claims will match; a
        // TECHNICAL_FAILURE published here reaches no trigger, so a fault on
        // our side never produces an apology blaming driver supply.
        publishCommunicationEvent({
            type: 'ride.not_fulfilled',
            rideId,
            passengerId: ride.passengerId,
            outcomeReason: failureOutcome,
            pickupArea: (ride as any).pickupSubLocality ?? (ride as any).pickupLocality ?? null,
            destinationArea: (ride as any).destinationSubLocality ?? (ride as any).destinationLocality ?? null,
            occurredAt: new Date().toISOString(),
        });

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
        OperationsBroadcastService.rideChanged(rideId);

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
                // Schedule automatic recovery rather than leaving the flag for
                // somebody to notice. A transient database or network problem
                // must not permanently cost KekeRide its commission — which is
                // exactly what happened to 99 rides over a month.
                await rideRepo.update(rideId, {
                    paymentFailed: true,
                    financialLastError: String(e?.message ?? 'unknown').slice(0, 300),
                    financialNextRetryAt: new Date(Date.now() + 60_000),
                } as any);
                this.io.to('admin').emit('ride:payment_failed', { rideId, error: e.message });
            }
        }

        await rideRepo.update(rideId, {
            status: 'completed' as any,
            completedAt: new Date(),
            outcomeReason: RideOutcomeCode.COMPLETED,
        });

        // Announce it for communications. Synchronous, returns void, and every
        // handler is isolated behind its own catch — a Resend outage cannot
        // reach this line, let alone fail the ride that just completed.
        publishCommunicationEvent({
            type: 'ride.completed',
            rideId,
            passengerId: ride.passengerId,
            outcomeReason: RideOutcomeCode.COMPLETED,
            pickupArea: (ride as any).pickupSubLocality ?? (ride as any).pickupLocality ?? null,
            destinationArea: (ride as any).destinationSubLocality ?? (ride as any).destinationLocality ?? null,
            occurredAt: new Date().toISOString(),
        });

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
