import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from "typeorm";

export enum TransactionStatus {
    PENDING = "pending",
    SUCCESS = "success",
    FAILED = "failed",
    REVERSED = "reversed"
}

@Entity()
export class Transaction {
    @PrimaryGeneratedColumn("uuid")
    id!: string;

    @Column()
    userId!: string;

    @Column({ type: "decimal", precision: 12, scale: 2 })
    amount!: number;

    @Index({ unique: true })
    @Column()
    reference!: string; // Paystack reference

    @Column({ type: "enum", enum: TransactionStatus, default: TransactionStatus.PENDING })
    status!: TransactionStatus;

    @Column({ nullable: true })
    paymentMethod!: string;

    @Column({ type: "jsonb", nullable: true })
    metadata!: any;

    @CreateDateColumn()
    createdAt!: Date;

    @UpdateDateColumn()
    updatedAt!: Date;
}
