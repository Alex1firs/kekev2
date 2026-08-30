import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from "typeorm";

/**
 * A city KekeRide operates in.
 *
 * ── The invariant this table exists to enforce ──────────────────────────
 * A ride belongs to the service zone containing its PICKUP, and normal dispatch
 * may only offer it to drivers whose CURRENT position resolves to that same
 * zone. Not the destination's zone, not the driver's registered zone, not the
 * dispatcher's.
 *
 * ── Why a polygon, when ParkZone deliberately chose a circle ────────────
 * A park's staging bay genuinely is a circle — "the shed, fifty metres" — and a
 * dispatcher can describe it out loud. A city is not. A circle around Onitsha
 * large enough to include Nkpor and Obosi also swallows several kilometres of
 * the Niger and a stretch of Delta State; one small enough to exclude them
 * strands passengers in Awada. The stakes differ too: a wrong park radius costs
 * a slightly worse ranking, a wrong city boundary refuses a real ride.
 *
 * ── status vs enforcement ───────────────────────────────────────────────
 * Two dials, deliberately separate, because they answer different questions.
 *
 *   status       is this zone OPERATIONAL? Only `active` zones are visible to
 *                the runtime resolver. A `draft` zone exists on the map and in
 *                reports and cannot influence dispatch at all.
 *   enforcement  for an operational zone, does the constraint DECIDE anything?
 *                `off` computes and logs but never applies; `observe` records
 *                what it would have done; `enforce` applies it.
 *
 * Collapsing these into one field is how a boundary drawn for next quarter
 * accidentally starts refusing rides today.
 */
export enum ServiceZoneStatus {
    /** Drawn and approved, not operating. Invisible to the runtime resolver. */
    DRAFT = "draft",
    ACTIVE = "active",
    /** Temporarily suspended — kept for history, not dispatched to. */
    PAUSED = "paused",
    RETIRED = "retired",
}

export enum ZoneEnforcement {
    /** Resolve and record; never filter, never refuse. */
    OFF = "off",
    /** Resolve, record, and log what enforcement WOULD have done. */
    OBSERVE = "observe",
    ENFORCE = "enforce",
}

/** Statuses whose geometry is approved and usable for CLASSIFYING history. */
export const CLASSIFIABLE_STATUSES: ServiceZoneStatus[] = [
    ServiceZoneStatus.DRAFT,
    ServiceZoneStatus.ACTIVE,
    ServiceZoneStatus.PAUSED,
];

/** The ONE status the runtime resolver will look at. */
export const OPERATIONAL_STATUSES: ServiceZoneStatus[] = [ServiceZoneStatus.ACTIVE];

@Entity()
@Index(["status", "enforcement"])
export class ServiceZone {
    @PrimaryGeneratedColumn("uuid")
    zoneId!: string;

    /**
     * The stable, human-readable key: ONI, AWK, NNE.
     *
     * This is what `ride.zoneCode` and friends reference, so it is immutable by
     * policy AND by a foreign key with ON UPDATE RESTRICT. Reports group by it
     * and an operator reading raw SQL during an incident sees `ONI` rather than
     * a uuid they cannot place.
     */
    @Index({ unique: true })
    @Column({ type: "varchar", length: 16 })
    code!: string;

    @Column({ type: "varchar", length: 120 })
    name!: string;

    @Column({ type: "varchar", length: 80, nullable: true })
    state!: string | null;

    @Column({ type: "varchar", length: 2, default: "NG" })
    country!: string;

    /** GeoJSON Polygon, [lng, lat] order. See service_zone_geometry.ts. */
    @Column({ type: "jsonb" })
    boundary!: unknown;

    // Derived from `boundary` on every write. Denormalised on purpose: this is
    // the prefilter, and recomputing it per resolution would defeat the point.
    @Column({ type: "double precision" })
    bboxMinLat!: number;

    @Column({ type: "double precision" })
    bboxMinLng!: number;

    @Column({ type: "double precision" })
    bboxMaxLat!: number;

    @Column({ type: "double precision" })
    bboxMaxLng!: number;

    /**
     * Edge tolerance for GPS drift, in metres. NOT an extension of the service
     * area: a buffer match is recorded as such and counted, so that "how many
     * rides depend on the tolerance" stays an answerable question. If that
     * number is ever non-trivial, the boundary is wrong and the fix is to
     * redraw it, not to widen this.
     */
    @Column({ type: "int", default: 400 })
    bufferMeters!: number;

    /** Higher wins where zones overlap. Ties break on `code`, deterministically. */
    @Column({ type: "int", default: 100 })
    priority!: number;

    @Index()
    @Column({ type: "varchar", length: 12, default: ServiceZoneStatus.DRAFT })
    status!: ServiceZoneStatus;

    @Column({ type: "varchar", length: 12, default: ZoneEnforcement.OFF })
    enforcement!: ZoneEnforcement;

    /**
     * Per-zone dispatch radius tiers. Null uses the global dispatch config, so
     * a new city can open with tighter tiers than an established one without a
     * deploy.
     */
    @Column({ type: "jsonb", nullable: true })
    radiusTiersKm!: number[] | null;

    @Column({ type: "varchar", length: 60, default: "Africa/Lagos" })
    timezone!: string;

    @Column({ type: "varchar", nullable: true })
    createdByStaffId!: string | null;

    @CreateDateColumn()
    createdAt!: Date;

    @UpdateDateColumn()
    updatedAt!: Date;
}
