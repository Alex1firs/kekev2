import { Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from "typeorm";

export enum DriverStatus {
    PENDING_DOCUMENTS = "pending_documents",
    PENDING_REVIEW = "pending_review",
    APPROVED = "approved",
    REJECTED = "rejected",
    SUSPENDED = "suspended"
}

@Entity()
export class DriverProfile {
    @Index()
    @PrimaryColumn()
    userId!: string; // References User.id

    @Column()
    firstName!: string;

    @Column()
    lastName!: string;

    @Column()
    vehiclePlate!: string;

    @Column()
    vehicleModel!: string;

    @Index()
    @Column({ type: "enum", enum: DriverStatus, default: DriverStatus.PENDING_DOCUMENTS })
    status!: DriverStatus;

    @Column({ type: 'varchar', length: 500, nullable: true })
    rejectionReason!: string;

    @Column({ nullable: true })
    licenseUrl!: string;

    @Column({ nullable: true })
    idCardUrl!: string;

    @Column({ nullable: true })
    vehiclePaperUrl!: string;

    @Column({ nullable: true })
    photoUrl!: string;

    @Column({ type: 'varchar', length: 50, nullable: true, default: null })
    nin!: string | null;

    @Column({ default: false })
    ninVerified!: boolean;

    /**
     * Denormalized passenger-rating aggregates. Average = ratingSum / ratingCount
     * (0 when ratingCount is 0). Stored as sum+count rather than a float average
     * so each new review is an exact, race-safe increment.
     */
    @Column({ type: "int", default: 0 })
    ratingSum!: number;

    @Column({ type: "int", default: 0 })
    ratingCount!: number;

    @CreateDateColumn()
    createdAt!: Date;

    @UpdateDateColumn()
    updatedAt!: Date;
}
