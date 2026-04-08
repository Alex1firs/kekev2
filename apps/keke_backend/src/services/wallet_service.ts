import { AppDataSource } from "../config/data_source";
import { Wallet } from "../models/Wallet";
import { LedgerEntry, BalanceType, TransactionType } from "../models/LedgerEntry";
import { Transaction, TransactionStatus } from "../models/Transaction";

export class WalletService {
    /**
     * Get or create a wallet for a user
     */
    static async getOrCreateWallet(userId: string): Promise<Wallet> {
        let wallet = await AppDataSource.getRepository(Wallet).findOneBy({ userId });
        if (!wallet) {
            wallet = AppDataSource.getRepository(Wallet).create({ userId });
            await AppDataSource.getRepository(Wallet).save(wallet);
        }
        return wallet;
    }

    /**
     * Mutate a specific balance with a ledger entry
     */
    static async mutateBalance(
        userId: string,
        amount: number, // positive for credit, negative for debit
        balanceType: BalanceType,
        transactionType: TransactionType,
        metadata: any = {}
    ): Promise<Wallet> {
        return await AppDataSource.transaction(async (manager) => {
            const wallet = await manager.findOne(Wallet, { where: { userId }, lock: { mode: "pessimistic_write" } });
            if (!wallet) throw new Error("Wallet not found");

            const balanceBefore = Number(wallet[balanceType as unknown as keyof Wallet] || 0);
            const balanceAfter = balanceBefore + amount;

            // 1. Update Wallet
            (wallet as any)[balanceType] = balanceAfter;
            await manager.save(wallet);

            // 2. Create Ledger Entry
            const ledger = manager.create(LedgerEntry, {
                walletId: userId,
                balanceType,
                transactionType,
                amount,
                balanceBefore,
                balanceAfter,
                metadata
            });
            await manager.save(ledger);

            return wallet;
        });
    }

    /**
     * Finalize a Paystack top-up (Idempotent)
     */
    static async finalizeTopup(reference: string, amount: number): Promise<void> {
        await AppDataSource.transaction(async (manager) => {
            const tx = await manager.findOne(Transaction, { where: { reference }, lock: { mode: "pessimistic_write" } });
            
            if (!tx) throw new Error("Transaction record not found");
            if (tx.status === TransactionStatus.SUCCESS) return; // Idempotency check

            // Update Transaction Status
            tx.status = TransactionStatus.SUCCESS;
            await manager.save(tx);

            // Credit Passenger Wallet
            await this.mutateBalance(
                tx.userId,
                amount,
                BalanceType.PASSENGER,
                TransactionType.TOPUP,
                { reference }
            );
        });
    }

    /**
     * Post Ride Financials (10% Commission)
     */
    static async postRideFinancials(data: {
        rideId: string;
        passengerId: string;
        driverId: string;
        totalFare: number;
        isCash: boolean;
    }): Promise<void> {
        const commissionAmount = data.totalFare * 0.10;
        const driverNetAmount = data.totalFare - commissionAmount;

        if (data.isCash) {
            // Cash Ride: Only track commission as debt
            await this.mutateBalance(
                data.driverId,
                commissionAmount,
                BalanceType.DRIVER_COMMISSION_DEBT,
                TransactionType.COMMISSION_CHARGE,
                { rideId: data.rideId, fare: data.totalFare }
            );
        } else {
            // Wallet Ride: Complex multi-wallet mutation
            // 1. Debit Passenger Total
            await this.mutateBalance(
                data.passengerId,
                -data.totalFare,
                BalanceType.PASSENGER,
                TransactionType.TRIP_PAYMENT,
                { rideId: data.rideId }
            );

            // 2. Credit Driver Net
            await this.mutateBalance(
                data.driverId,
                driverNetAmount,
                BalanceType.DRIVER_AVAILABLE,
                TransactionType.TRIP_PAYMENT,
                { rideId: data.rideId, commission: commissionAmount }
            );
            
            // Note: Platform 10% is implicitly the difference, 
            // in a full system we'd credit a Platform Wallet here too.
        }
    }
}
