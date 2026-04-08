import { Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn } from "typeorm";

@Entity()
export class Wallet {
    @PrimaryColumn()
    userId!: string;

    @Column({ type: "decimal", precision: 12, scale: 2, default: 0 })
    passengerBalance!: number;

    @Column({ type: "decimal", precision: 12, scale: 2, default: 0 })
    driverAvailableBalance!: number;

    @Column({ type: "decimal", precision: 12, scale: 2, default: 0 })
    driverPendingBalance!: number;

    @Column({ type: "decimal", precision: 12, scale: 2, default: 0 })
    driverCommissionDebt!: number;

    @CreateDateColumn()
    createdAt!: Date;

    @UpdateDateColumn()
    updatedAt!: Date;
}
