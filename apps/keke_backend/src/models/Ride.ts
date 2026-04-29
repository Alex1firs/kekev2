import { Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from "typeorm";

export enum RideStatus {
    SEARCHING = "searching",
    ACCEPTED = "accepted",
    ARRIVED = "arrived",
    IN_PROGRESS = "in_progress",
    STARTED = "started",
    COMPLETED = "completed",
    CANCELED = "canceled",
    FAILED = "failed"
}

@Entity()
@Index(["passengerId", "status"])
@Index(["driverId", "status"])
@Index(["status", "updatedAt"])
export class Ride {
    @PrimaryColumn()
    rideId!: string;

    @Index()
    @Column()
    passengerId!: string;

    @Index()
    @Column({ nullable: true })
    driverId!: string;

    @Column({ type: "decimal", precision: 12, scale: 2 })
    fare!: number;

    @Column()
    paymentMode!: "wallet" | "cash";

    @Index()
    @Column({ type: "enum", enum: RideStatus, default: RideStatus.SEARCHING })
    status!: RideStatus;

    @Column({ nullable: true })
    pickupAddress!: string;

    @Column({ nullable: true })
    destinationAddress!: string;

    @Column({ type: "decimal", precision: 10, scale: 7, nullable: true })
    pickupLat!: number;

    @Column({ type: "decimal", precision: 10, scale: 7, nullable: true })
    pickupLng!: number;

    @Column({ type: "decimal", precision: 10, scale: 7, nullable: true })
    destinationLat!: number;

    @Column({ type: "decimal", precision: 10, scale: 7, nullable: true })
    destinationLng!: number;

    @Column({ nullable: true, default: false })
    paymentFailed!: boolean;

    @CreateDateColumn()
    createdAt!: Date;

    @UpdateDateColumn()
    updatedAt!: Date;

    @Column({ nullable: true })
    completedAt!: Date;
}
