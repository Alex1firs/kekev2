import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne } from "typeorm";
import { Wallet } from "./Wallet";

export enum BalanceType {
    PASSENGER = "passenger",
    DRIVER_AVAILABLE = "driver_available",
    DRIVER_PENDING = "driver_pending",
    DRIVER_COMMISSION_DEBT = "driver_commission_debt"
}

export enum TransactionType {
    TOPUP = "topup",
    TRIP_PAYMENT = "trip_payment",
    COMMISSION_CHARGE = "commission_charge",
    PAYOUT = "payout",
    REFUND = "refund"
}

@Entity()
export class LedgerEntry {
    @PrimaryGeneratedColumn("uuid")
    id!: string;

    @ManyToOne(() => Wallet)
    wallet!: Wallet;

    @Column()
    walletId!: string;

    @Column({ type: "enum", enum: BalanceType })
    balanceType!: BalanceType;

    @Column({ type: "enum", enum: TransactionType })
    transactionType!: TransactionType;

    @Column({ type: "decimal", precision: 12, scale: 2 })
    amount!: number;

    @Column({ type: "decimal", precision: 12, scale: 2 })
    balanceBefore!: number;

    @Column({ type: "decimal", precision: 12, scale: 2 })
    balanceAfter!: number;

    @Column({ type: "jsonb", nullable: true })
    metadata!: any;

    @CreateDateColumn()
    createdAt!: Date;
}
