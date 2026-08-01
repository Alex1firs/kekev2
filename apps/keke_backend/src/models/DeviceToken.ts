import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from "typeorm";
import { UserRole } from "./User";

@Entity()
export class DeviceToken {
    @PrimaryGeneratedColumn("uuid")
    id!: string;

    @Index()
    @Column()
    userId!: string;

    @Column({ type: "enum", enum: UserRole })
    role!: UserRole;

    @Column()
    platform!: "ios" | "android";

    @Column({ unique: true })
    token!: string;

    @Column({ nullable: true })
    deviceLabel?: string;

    /**
     * App version this device last registered with, e.g. "1.4.2".
     *
     * Null for every install that predates the change, which is exactly what
     * makes it useful: contact-privacy enforcement treats an unknown version as
     * OLD and keeps the legacy behaviour, so tightening the offer payload can
     * never break an app that has not told us what it is.
     * See services/contact_access_service.ts.
     */
    @Column({ type: "varchar", length: 32, nullable: true })
    appVersion?: string | null;

    @Index()
    @Column({ default: true })
    isActive!: boolean;

    @CreateDateColumn()
    createdAt!: Date;

    @UpdateDateColumn()
    updatedAt!: Date;

    @Column({ type: "timestamp", nullable: true })
    lastSeenAt?: Date;
}
