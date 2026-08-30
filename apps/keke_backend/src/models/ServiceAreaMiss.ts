import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from "typeorm";

/**
 * A ride request whose pickup we could not serve.
 *
 * ── Why this is not a Ride row ──────────────────────────────────────────
 * Recording an unservable request as a `failed` ride would put it into ride
 * counts, fare statistics, dispatch outcome reporting and every operational
 * dashboard — as if we had tried and lost. We did not try. It is a different
 * kind of fact and it gets a different table.
 *
 * ── Why it is recorded in every enforcement mode ────────────────────────
 * The rows accumulate from the moment the architecture ships, long before
 * anything is refused. By the time enforcement goes live we already know
 * exactly how many requests it will turn away and where they are — so the
 * decision to enforce is made against evidence, and the map of our misses
 * doubles as the map of where to open next.
 *
 * `passengerId` is `varchar` to match `ride.passengerId`, which is how this
 * codebase stores user ids in operational tables — `user.id` is a uuid, but
 * nothing joins these two directly and a type mismatch would be worse than the
 * inconsistency.
 */
export enum MissResolution {
    /** Valid coordinates, genuinely outside every operational zone. */
    OUTSIDE = "outside",
    /** The resolver could not answer. NOT the same fact, never merged. */
    ERROR = "error",
}

@Entity()
@Index(["createdAt"])
@Index(["nearestZoneCode", "createdAt"])
export class ServiceAreaMiss {
    @PrimaryGeneratedColumn("uuid")
    id!: string;

    @Index()
    @Column({ type: "varchar" })
    passengerId!: string;

    @Column({ type: "decimal", precision: 10, scale: 7 })
    lat!: number;

    @Column({ type: "decimal", precision: 10, scale: 7 })
    lng!: number;

    /** Nearest operational zone, when there was one to name. */
    @Column({ type: "varchar", length: 16, nullable: true })
    nearestZoneCode!: string | null;

    /** Metres to that zone's edge. Null when nothing could be measured. */
    @Column({ type: "int", nullable: true })
    distanceMeters!: number | null;

    @Column({ type: "varchar", length: 12 })
    resolution!: MissResolution;

    /**
     * What enforcement mode was live when this was recorded.
     *
     * Without it the table cannot answer its own most important question: was
     * this passenger actually turned away, or merely counted? A miss recorded
     * under `off` was served exactly as before.
     */
    @Column({ type: "varchar", length: 12 })
    enforcementAtTime!: string;

    /** True when the passenger was actually refused. */
    @Column({ type: "boolean", default: false })
    refused!: boolean;

    @CreateDateColumn()
    createdAt!: Date;
}
