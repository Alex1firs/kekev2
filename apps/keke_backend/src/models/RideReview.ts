import { Entity, PrimaryColumn, Column, CreateDateColumn, Index } from "typeorm";

/**
 * One passenger-authored review per completed ride. The `rideId` primary key
 * enforces idempotency — a passenger can rate a given trip at most once.
 * Driver aggregates (ratingSum / ratingCount) live on DriverProfile so we
 * never have to aggregate this table on read.
 */
@Entity()
/*
 * No class-level @Index(["driverId"]) here.
 *
 * `driverId` already carries a column-level @Index, and TypeORM derives index
 * names from table + columns — so both produced the SAME name and building this
 * schema from empty failed with "relation IDX_ef0f7e… already exists". Nobody
 * noticed because production's schema grew incrementally and was never created
 * from scratch; it bites the first person to stand up a fresh environment.
 *
 * The index itself is unchanged: same table, same column, same generated name.
 */
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
