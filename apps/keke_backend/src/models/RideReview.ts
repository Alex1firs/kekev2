import { Entity, PrimaryColumn, Column, CreateDateColumn, Index } from "typeorm";

/**
 * One passenger-authored review per completed ride. The `rideId` primary key
 * enforces idempotency — a passenger can rate a given trip at most once.
 * Driver aggregates (ratingSum / ratingCount) live on DriverProfile so we
 * never have to aggregate this table on read.
 */
@Entity()
@Index(["driverId"])
export class RideReview {
    @PrimaryColumn()
    rideId!: string; // References Ride.rideId — one review per ride

    @Index()
    @Column()
    passengerId!: string;

    @Index()
    @Column()
    driverId!: string;

    /** 1..5 stars. */
    @Column({ type: "int" })
    stars!: number;

    /** Quick-tap reason chips, only populated for low ratings. */
    @Column({ type: "jsonb", default: () => "'[]'" })
    tags!: string[];

    @Column({ type: "varchar", length: 500, nullable: true })
    comment!: string | null;

    @CreateDateColumn()
    createdAt!: Date;
}
