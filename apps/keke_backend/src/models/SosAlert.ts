import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from "typeorm";
import { UserRole } from "./User";

export enum SosAlertStatus {
    ACTIVE = "active",
    RESOLVED = "resolved",
    FALSE_ALARM = "false_alarm"
}

@Entity()
@Index(["rideId"])
@Index(["status"])
export class SosAlert {
    @PrimaryGeneratedColumn("uuid")
    id!: string;

    @Column()
    rideId!: string;

    @Column()
    initiatorId!: string;

    @Column({ type: "enum", enum: UserRole })
    initiatorRole!: UserRole;

    @Column({ nullable: true })
    reason!: string;

    @Column({ type: "text", nullable: true })
    description!: string;

    @Column({ type: "decimal", precision: 10, scale: 7, nullable: true })
    lat!: number;

    @Column({ type: "decimal", precision: 10, scale: 7, nullable: true })
    lng!: number;

    @Column({ type: "enum", enum: SosAlertStatus, default: SosAlertStatus.ACTIVE })
    status!: SosAlertStatus;

    @CreateDateColumn()
    createdAt!: Date;

    @UpdateDateColumn()
    updatedAt!: Date;

    @Column({ nullable: true })
    resolvedAt!: Date;
}
