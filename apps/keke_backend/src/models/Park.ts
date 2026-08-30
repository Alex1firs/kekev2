import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from "typeorm";

/**
 * Operating state of a park.
 *
 * DRAFT exists so a park can be created, given zones, a roster and a supervisor,
 * and reviewed BEFORE it is capable of receiving anything. A park that is
 * half-configured must not be a candidate for supply, and "remember not to use
 * it yet" is not a control.
 */
export enum ParkStatus {
    /** Being set up. Never eligible for dispatch, never shown as supply. */
    DRAFT = "draft",
    /** Live. */
    ACTIVE = "active",
    /** Deliberately paused — off-season, refurbishment, no staff. Reversible. */
    INACTIVE = "inactive",
    /** Barred by operations, e.g. after an incident. Reversible, reason required. */
    SUSPENDED = "suspended",
}

/**
 * A physical Keke park: a real place where drivers wait, with real staff.
 *
 * First-class entity, not a driver account and not merely a coordinate. It is
 * simultaneously an operational unit (roster, dispatchers, shifts), a geographic
 * supply node (a point plus a service radius) and a configuration holder
 * (capacity, hours, priority).
 *
 * Two radii, and the difference matters operationally:
 *   operatingRadiusM  — how far from the pin a dispatcher device may be and
 *                       still count as on-site. Used at shift start.
 *   serviceRadiusKm   — how far a pickup may be for this park to be a candidate.
 *
 * Driver counts are deliberately NOT columns here. See ParkService.counts():
 * they are derived from the roster and live presence, because a denormalised
 * counter that drifts is worse than a join.
 */
@Entity()
@Index(["status", "priority"])
export class Park {
    @PrimaryGeneratedColumn("uuid")
    parkId!: string;

    @Column({ type: "varchar", length: 120 })
    name!: string;

    /**
     * Short human code used on radios, badges and printed sheets — e.g.
     * `AWK-MAIN`. Unique, upper-case, stable for the life of the park.
     */
    @Index({ unique: true })
    @Column({ type: "varchar", length: 24 })
    code!: string;

    @Column({ type: "varchar", length: 300, nullable: true })
    addressLine!: string | null;

    /**
     * The service zone this park sits in. Park SELECTION still uses the park's
     * own serviceRadiusKm — this is provenance and reporting, not a second
     * geographic gate.
     */
    @Column({ type: "varchar", length: 16, nullable: true })
    zoneCode!: string | null;

    @Column({ type: "varchar", length: 80, nullable: true })
    city!: string | null;

    @Column({ type: "varchar", length: 80, nullable: true })
    state!: string | null;

    // Same precision as Ride.pickupLat/Lng so distances compare exactly.
    @Column({ type: "decimal", precision: 10, scale: 7 })
    lat!: number;

    @Column({ type: "decimal", precision: 10, scale: 7 })
    lng!: number;

    /** On-site radius for shift-start location attestation. Metres. */
    @Column({ type: "int", default: 200 })
    operatingRadiusM!: number;

    /** How far from the park a pickup may be for this park to be eligible. */
    @Column({ type: "double precision", default: 4 })
    serviceRadiusKm!: number;

    /** How many drivers the physical park can hold. Advisory: over-capacity warns, never blocks. */
    @Column({ type: "int", default: 50 })
    capacityDrivers!: number;

    /** Ceiling on simultaneously-owned ride requests. Enforced in a later phase. */
    @Column({ type: "int", default: 3 })
    maxConcurrentAssignments!: number;

    /** Higher wins when two parks could serve one pickup. */
    @Index()
    @Column({ type: "int", default: 0 })
    priority!: number;

    @Index()
    @Column({ type: "enum", enum: ParkStatus, default: ParkStatus.DRAFT })
    status!: ParkStatus;

    // ── Operating hours ─────────────────────────────────────────────────
    // Stored as local wall-clock strings plus a timezone rather than UTC
    // instants: a park opens at 6am local, which is not a fixed UTC time.

    /** `HH:MM`, park-local. Null means no configured opening time. */
    @Column({ type: "varchar", length: 5, nullable: true })
    opensAt!: string | null;

    @Column({ type: "varchar", length: 5, nullable: true })
    closesAt!: string | null;

    /** ISO days of week the park operates: 1 = Monday … 7 = Sunday. */
    @Column({ type: "jsonb", default: () => `'[1,2,3,4,5,6,7]'` })
    daysOfWeek!: number[];

    @Column({ type: "varchar", length: 60, default: "Africa/Lagos" })
    timezone!: string;

    /** Trip types this park serves. Reserved; unused while only one type exists. */
    @Column({ type: "jsonb", nullable: true })
    supportedTripTypes!: string[] | null;

    // ── Accountability ──────────────────────────────────────────────────

    /**
     * The one person accountable for this park.
     *
     * Distinct from "who may dispatch here", which is the set of park-scoped
     * role assignments. A park can have five dispatchers and exactly one
     * supervisor, and an escalation needs to reach a named person, not a set.
     */
    @Index()
    @Column({ type: "varchar", nullable: true })
    supervisorStaffId!: string | null;

    @Column({ type: "varchar", length: 120, nullable: true })
    escalationContactName!: string | null;

    @Column({ type: "varchar", length: 32, nullable: true })
    escalationContactPhone!: string | null;

    /** Reserved for a future park revenue share. Unused in v1 — flat commission only. */
    @Column({ type: "jsonb", nullable: true })
    commissionConfig!: Record<string, unknown> | null;

    // ── Suspension ──────────────────────────────────────────────────────

    @Column({ type: "timestamp", nullable: true })
    suspendedAt!: Date | null;

    @Column({ type: "varchar", nullable: true })
    suspendedByStaffId!: string | null;

    @Column({ type: "varchar", length: 500, nullable: true })
    suspensionReason!: string | null;

    @Column({ type: "varchar", nullable: true })
    createdByStaffId!: string | null;

    @CreateDateColumn()
    createdAt!: Date;

    @UpdateDateColumn()
    updatedAt!: Date;
}
