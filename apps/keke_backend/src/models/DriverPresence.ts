import { Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from "typeorm";

/**
 * Where a driver actually is in their working day.
 *
 * This is NOT the dispatch availability heartbeat (`driver:available:` in
 * Redis, 45s TTL) and must never be confused with it. That key answers "could
 * dispatch ring this phone in the next few seconds"; these states answer "what
 * is this human doing". A feature-phone driver standing in a park has no
 * heartbeat at all and is very much AT_PARK.
 *
 * Presence changes INDEPENDENTLY of the ride lifecycle. A ride moving to
 * `accepted` does not itself move a driver to ASSIGNED — something has to
 * record that, and until Phase 4 wires it, presence is driven by the driver app
 * and by dispatchers. Keeping the two decoupled is deliberate: a presence bug
 * must never be able to corrupt a ride, and a ride bug must never silently
 * rewrite what we believe about a person's whereabouts.
 */
export enum DriverPresenceState {
    /** Not working. The resting state. */
    OFFLINE = "offline",
    /** Working, but not at a park — the ordinary roaming driver. */
    ONLINE = "online",
    /** Physically present at a park, not yet in its queue. */
    AT_PARK = "at_park",
    /** At a park and in the queue, waiting for work. */
    WAITING = "waiting",
    /** Given a ride, not yet moving. */
    ASSIGNED = "assigned",
    /** Travelling to the pickup. */
    EN_ROUTE = "en_route",
    /** At the pickup, passenger getting in. */
    PASSENGER_BOARDING = "passenger_boarding",
    /** Carrying a passenger. */
    TRIP_STARTED = "trip_started",
    /** Present but not taking work — break, fuel, prayers, repair. */
    UNAVAILABLE = "unavailable",
}

/** Who caused a presence change. Every transition records one. */
export enum PresenceSource {
    /** The driver's own app. */
    DRIVER_APP = "driver_app",
    /** A dispatcher recorded it at a park, typically for a feature-phone driver. */
    DISPATCHER = "dispatcher",
    /** An administrator corrected it. */
    ADMIN = "admin",
    /** Derived by the backend (e.g. a heartbeat lapsing). */
    SYSTEM = "system",
}

/**
 * Current presence for one driver. Exactly one row per driver, updated in place.
 *
 * The history lives in DriverPresenceEvent — this table answers "now" fast, and
 * that table answers "how did we get here".
 */
@Entity()
@Index(["state", "parkId"])
@Index(["parkId", "state", "since"])
export class DriverPresence {
    /** References User.id / DriverProfile.userId. */
    @PrimaryColumn()
    driverId!: string;

    @Index()
    @Column({ type: "enum", enum: DriverPresenceState, default: DriverPresenceState.OFFLINE })
    state!: DriverPresenceState;

    /** The park this presence relates to, when it relates to one. */
    @Index()
    @Column({ type: "varchar", nullable: true })
    parkId!: string | null;

    /**
     * When the CURRENT state was entered — not when the row was last written.
     *
     * This is what "waiting 47 minutes" is computed from, so a no-op update must
     * not reset it. PresenceService only moves it on a genuine transition.
     */
    @Column({ type: "timestamp" })
    since!: Date;

    @Column({ type: "enum", enum: PresenceSource, default: PresenceSource.SYSTEM })
    source!: PresenceSource;

    /** The staff member who recorded it, when a human did. */
    @Column({ type: "varchar", nullable: true })
    setByStaffId!: string | null;

    /** The ride this presence is about, for the four ride-shaped states. */
    @Index()
    @Column({ type: "varchar", nullable: true })
    rideId!: string | null;

    /** Free text for UNAVAILABLE — "fuel", "repair", "prayers". */
    @Column({ type: "varchar", length: 200, nullable: true })
    note!: string | null;

    @Column({ type: "enum", enum: DriverPresenceState, nullable: true })
    previousState!: DriverPresenceState | null;

    /**
     * Last time the driver's app reported in, for app-capable drivers.
     *
     * Separate from the Redis dispatch heartbeat and never read by dispatch. It
     * exists so an operations screen can say "app last seen 4 minutes ago"
     * without reaching into dispatch internals.
     */
    @Column({ type: "timestamp", nullable: true })
    lastHeartbeatAt!: Date | null;

    @CreateDateColumn()
    createdAt!: Date;

    @UpdateDateColumn()
    updatedAt!: Date;
}
