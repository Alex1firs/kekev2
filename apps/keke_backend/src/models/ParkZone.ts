import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from "typeorm";

/**
 * What a zone is FOR. A park's geography is not one undifferentiated blob:
 * where drivers physically queue, where a passenger is met, and which
 * neighbourhoods a park serves are three different questions.
 */
export enum ParkZoneKind {
    /** A sub-area of the service radius this park covers. */
    SERVICE = "service",
    /** Where drivers physically wait inside the park. */
    STAGING = "staging",
    /** Where a passenger meets their Keke. */
    BOARDING = "boarding",
}

/**
 * A named sub-area of a park.
 *
 * Modelled as a CIRCLE (centre + radius), not a polygon. PostGIS is not
 * installed, and a circle is both sufficient for pilot operations and
 * something a dispatcher can describe out loud — "the shed, fifty metres" —
 * which a polygon is not. If real coverage disputes appear in the pilot data,
 * polygons become a considered upgrade rather than premature machinery.
 */
@Entity()
@Index(["parkId", "kind", "active"])
export class ParkZone {
    @PrimaryGeneratedColumn("uuid")
    zoneId!: string;

    @Index()
    @Column()
    parkId!: string;

    @Column({ type: "varchar", length: 120 })
    name!: string;

    /** Short code unique WITHIN a park, e.g. `BAY-A`. */
    @Column({ type: "varchar", length: 24 })
    code!: string;

    @Column({ type: "enum", enum: ParkZoneKind, default: ParkZoneKind.SERVICE })
    kind!: ParkZoneKind;

    @Column({ type: "decimal", precision: 10, scale: 7 })
    lat!: number;

    @Column({ type: "decimal", precision: 10, scale: 7 })
    lng!: number;

    @Column({ type: "int", default: 150 })
    radiusM!: number;

    /** Ordering when several zones overlap. Higher wins. */
    @Column({ type: "int", default: 0 })
    priority!: number;

    /** How many drivers this zone holds. Only meaningful for STAGING. */
    @Column({ type: "int", nullable: true })
    capacityDrivers!: number | null;

    @Index()
    @Column({ default: true })
    active!: boolean;

    @Column({ type: "varchar", length: 500, nullable: true })
    notes!: string | null;

    @Column({ type: "varchar", nullable: true })
    createdByStaffId!: string | null;

    @CreateDateColumn()
    createdAt!: Date;

    @UpdateDateColumn()
    updatedAt!: Date;
}
