import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from "typeorm";

/**
 * The strongest dispatch facts we can actually record, and nothing softer.
 *
 * There is deliberately NO "notification delivered", "driver saw the request" or
 * inferred-rejection member. FCM gives us provider acceptance, not delivery; a
 * socket emit tells us a connected socket was written to, not that a human
 * looked at a screen. The only genuine device-level signal is
 * [[DEVICE_OFFER_ACK]], which the driver app sends when the offer actually
 * renders — and older driver builds do not send it at all.
 */
export enum DispatchEventType {
    /** Ride row created and dispatch started. */
    RIDE_CREATED = "ride_created",
    /** A dispatch round opened, with its radius tiers. */
    ROUND_STARTED = "round_started",
    /** Round N ended without acceptance and round N+1 began. */
    ROUND_TRANSITION = "round_transition",

    /** Returned by the geo query for this round (nearest-first). */
    CANDIDATE_DISCOVERED = "candidate_discovered",
    /** Passed every eligibility rule (approved, not busy, cash-eligible…). */
    ELIGIBILITY_PASSED = "eligibility_passed",
    /** Dropped by an eligibility rule. `detail.reason` says which. */
    ELIGIBILITY_REJECTED = "eligibility_rejected",
    /** Heartbeat/location went stale between discovery and the offer. */
    CANDIDATE_STALE = "candidate_stale",

    /** This ride atomically won the driver's reservation. */
    RESERVATION_ACQUIRED = "reservation_acquired",
    /** Another ride held the driver, so this ride skipped them. */
    RESERVATION_CONFLICT = "reservation_conflict",

    /** Offer handed to the transport layer. */
    NOTIFICATION_QUEUED = "notification_queued",
    /** ride:request written to a socket that was connected at that moment. */
    SOCKET_OFFER_EMITTED = "socket_offer_emitted",
    /** FCM accepted >=1 token. Provider acceptance — NOT device delivery. */
    FCM_ACCEPTED_BY_PROVIDER = "fcm_accepted_by_provider",
    /** Neither transport could carry the offer. */
    OFFER_DELIVERY_FAILED = "offer_delivery_failed",
    /** The driver app confirmed the offer rendered on the device. */
    DEVICE_OFFER_ACK = "device_offer_ack",

    /** The driver explicitly declined. No reason is collected today. */
    DRIVER_REJECTED = "driver_rejected",
    /** The offer window closed with no response of any kind. */
    OFFER_EXPIRED = "offer_expired",
    /** The driver accepted and the ride was assigned. */
    DRIVER_ACCEPTED = "driver_accepted",

    /** Dispatch ended with no assignment. `detail.outcomeCode` carries why. */
    DISPATCH_FAILED = "dispatch_failed",
    /** The passenger cancelled, or the system did — see `detail.cancelledBy`. */
    RIDE_CANCELLED = "ride_cancelled",

    // ── Lifecycle expiry / stale-ride recovery ───────────────────────────
    /** The sweep found this ride past its state's deadline. */
    STALE_RIDE_DETECTED = "stale_ride_detected",
    /** A staged warning was sent before any terminal action. */
    STALE_WARNING_SENT = "stale_warning_sent",
    /** A driver confirmed they are still coming; deadline extended once. */
    STALE_EXTENSION_GRANTED = "stale_extension_granted",
    /** The system cancelled the ride. `detail.reason` is the SYSTEM_* code. */
    STALE_AUTO_CANCELLED = "stale_auto_cancelled",
    /** An over-running in-progress trip was flagged for humans, NOT cancelled. */
    OPERATIONS_REVIEW_REQUIRED = "operations_review_required",
    /** Every piece of held state for a terminated ride was released. */
    STALE_CLEANUP_COMPLETED = "stale_cleanup_completed",

    // ── The decision window: no ride is cancelled before both are asked ──
    /** Both parties were asked whether to keep waiting or cancel. */
    STALE_DECISION_REQUESTED = "stale_decision_requested",
    /** One party answered. `detail.by` and `detail.choice` say who and what. */
    STALE_DECISION_RECEIVED = "stale_decision_received",
    /** The decision window closed with nobody answering. */
    STALE_DECISION_TIMED_OUT = "stale_decision_timed_out",
}

/**
 * Append-only audit trail of dispatch, for operational monitoring and support.
 *
 * This is the PERSISTED EVIDENCE tier. It is written from the same authoritative
 * hooks the live DispatchEvidence ledger uses — it is a durable projection of
 * those events, never a second ledger with its own opinions, and nothing in
 * dispatch reads it back.
 *
 * Contains NO personal data: only opaque ride and driver ids. Names, phones and
 * plates are joined from User/DriverProfile at render time, masked by default.
 */
@Entity()
@Index(["rideId", "sequence"])
@Index(["driverId", "createdAt"])
@Index(["eventType", "createdAt"])
export class DispatchEvent {
    @PrimaryGeneratedColumn("uuid")
    id!: string;

    @Index()
    @Column()
    rideId!: string;

    /**
     * Monotonic per-ride ordering. Wall-clock timestamps collide at millisecond
     * resolution when several offers go out in the same tick, which would make
     * the admin timeline non-deterministic; this keeps it stable.
     */
    @Column({ type: "int", default: 0 })
    sequence!: number;

    @Index()
    @Column({ type: "enum", enum: DispatchEventType })
    eventType!: DispatchEventType;

    /** 1-based dispatch round, when the event belongs to one. */
    @Column({ type: "int", nullable: true })
    dispatchRound!: number | null;

    /** The candidate driver, for per-driver events. */
    @Column({ type: "varchar", nullable: true })
    driverId!: string | null;

    /** Radius tier being worked when this happened. */
    @Column({ type: "double precision", nullable: true })
    radiusKm!: number | null;

    /** Candidate's distance from pickup at discovery. */
    @Column({ type: "double precision", nullable: true })
    distanceKm!: number | null;

    /** Age of the driver's heartbeat at this moment, in ms. */
    @Column({ type: "int", nullable: true })
    heartbeatAgeMs!: number | null;

    /** Age of the driver's last known location at this moment, in ms. */
    @Column({ type: "int", nullable: true })
    locationAgeMs!: number | null;

    /** Structured, non-personal context (reason codes, counts, outcome codes). */
    @Column({ type: "jsonb", nullable: true })
    detail!: Record<string, unknown> | null;

    /** When the event happened, from the dispatcher's clock. */
    @Column({ type: "timestamp" })
    occurredAt!: Date;

    /** When it was persisted (may lag occurredAt under load). */
    @CreateDateColumn()
    createdAt!: Date;
}

/**
 * How confident we are that an offer reached the driver's device, strongest
 * first. Presented to admins verbatim — never upgraded by inference.
 */
export enum OfferDeliveryState {
    /** The driver app confirmed the offer rendered. The only real proof. */
    ACKNOWLEDGED = "acknowledged",
    /** FCM accepted the push. The provider has it; the handset may not. */
    PROVIDER_ACCEPTED = "provider_accepted",
    /** Written to a live socket. Transport-level only. */
    SOCKET_EMITTED = "socket_emitted",
    /** Neither transport could carry it. */
    FAILED = "failed",
    /** Queued, but nothing confirmed anything. Say so plainly. */
    UNKNOWN = "unknown",
}
