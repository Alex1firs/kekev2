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

    @Column({ nullable: true })
    rejectionReason!: string;

    @Column({ nullable: true })
    licenseUrl!: string;

    @Column({ nullable: true })
    idCardUrl!: string;

    @Column({ nullable: true })
    vehiclePaperUrl!: string;

    @CreateDateColumn()
    createdAt!: Date;

    @UpdateDateColumn()
    updatedAt!: Date;
}
