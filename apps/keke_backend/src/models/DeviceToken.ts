import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from "typeorm";
import { UserRole } from "./User";

@Entity()
export class DeviceToken {
    @PrimaryGeneratedColumn("uuid")
    id!: string;

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

    @Column({ default: true })
    isActive!: boolean;

    @CreateDateColumn()
    createdAt!: Date;

    @UpdateDateColumn()
    updatedAt!: Date;

    @Column({ type: "timestamp", nullable: true })
    lastSeenAt?: Date;
}
