import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from "typeorm";

export enum PayoutStatus {
    PENDING = "pending",
    PROCESSING = "processing",
    SUCCESS = "success",
    FAILED = "failed"
}

@Entity()
export class PayoutRecord {
    @PrimaryGeneratedColumn("uuid")
    id!: string;

    @Column()
    driverId!: string;

    @Column({ type: "decimal", precision: 12, scale: 2 })
    amount!: number;

    @Column({ type: "enum", enum: PayoutStatus, default: PayoutStatus.PENDING })
    status!: PayoutStatus;

    @Column({ nullable: true })
    bankCode!: string;

    @Column({ nullable: true })
    accountNumber!: string;

    @Column({ nullable: true })
    reference!: string;

    @CreateDateColumn()
    createdAt!: Date;

    @UpdateDateColumn()
    updatedAt!: Date;
}
