import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from "typeorm";

@Entity()
export class AuditLog {
    @PrimaryGeneratedColumn("uuid")
    id!: string;

    @Column()
    adminId!: string; // Current: "SYSTEM_ADMIN"

    @Column()
    action!: string; // "APPROVE_DRIVER", "REJECT_DRIVER", etc.

    @Column()
    entityType!: string; // "DRIVER_PROFILE", "RIDE", etc.

    @Column()
    entityId!: string;

    @Column({ type: "jsonb", nullable: true })
    details!: any; // Minimal non-sensitive context

    @CreateDateColumn()
    createdAt!: Date;
}
