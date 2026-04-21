import { Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn } from "typeorm";

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
export class Ride {
    @PrimaryColumn()
    rideId!: string;

    @Column()
    passengerId!: string;

    @Column({ nullable: true })
    driverId!: string;

    @Column({ type: "decimal", precision: 12, scale: 2 })
    fare!: number;

    @Column()
    paymentMode!: "wallet" | "cash";

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

    @CreateDateColumn()
    createdAt!: Date;

    @UpdateDateColumn()
    updatedAt!: Date;

    @Column({ nullable: true })
    completedAt!: Date;
}
