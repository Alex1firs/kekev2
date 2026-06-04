import { AppDataSource } from "../config/data_source";
import { Wallet } from "../models/Wallet";
import { LedgerEntry, BalanceType, TransactionType } from "../models/LedgerEntry";
import { Transaction, TransactionStatus } from "../models/Transaction";
import { PayoutRecord, PayoutStatus } from "../models/PayoutRecord";
import { AuditLog } from "../models/AuditLog";
import { SettingService } from "./setting_service";


// Maps BalanceType enum values to actual Wallet entity property names.
const BALANCE_FIELD: Record<string, string> = {
    [BalanceType.PASSENGER]:              'passengerBalance',
    [BalanceType.DRIVER_AVAILABLE]:       'driverAvailableBalance',
    [BalanceType.DRIVER_PENDING]:         'driverPendingBalance',
    [BalanceType.DRIVER_COMMISSION_DEBT]: 'driverCommissionDebt',
};

export const DEBT_WARN_THRESHOLD    = 1000;  // ₦1,000 — show warning
export const DEBT_CASH_BLOCK        = 2000;  // ₦2,000 — blocked from cash rides
export const DEBT_HARD_BLOCK        = 5000;  // ₦5,000 — cannot go online at all

export class WalletService {
    static async getOrCreateWallet(userId: string): Promise<Wallet> {
        let wallet = await AppDataSource.getRepository(Wallet).findOneBy({ userId });
        if (!wallet) {
            wallet = AppDataSource.getRepository(Wallet).create({ userId });
            await AppDataSource.getRepository(Wallet).save(wallet);
        }
        return wallet;
    }

    static async mutateBalance(
        userId: string,
        amount: number,
        balanceType: BalanceType,
        transactionType: TransactionType,
        metadata: any = {}
    ): Promise<Wallet> {
        return await AppDataSource.transaction(async (manager) => {
            let wallet = await manager.findOne(Wallet, { where: { userId }, lock: { mode: "pessimistic_write" } });
            if (!wallet) {
                wallet = manager.create(Wallet, { userId });
                await manager.save(wallet);
            }

            const field = BALANCE_FIELD[balanceType];
            if (!field) throw new Error(`Unknown balance type: ${balanceType}`);

            const balanceBefore = Number((wallet as any)[field] || 0);
            const balanceAfter = balanceBefore + amount;

            (wallet as any)[field] = balanceAfter;
            await manager.save(wallet);

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
     * Returns the driver's current commission debt. Used by dispatch to gate cash rides.
     */
    static async getDriverDebt(driverId: string): Promise<number> {
        const wallet = await AppDataSource.getRepository(Wallet).findOneBy({ userId: driverId });
        return wallet ? Number(wallet.driverCommissionDebt) : 0;
    }

    /**
     * Bulk-filter driver IDs to those eligible to receive cash rides (debt < DEBT_CASH_BLOCK).
     */
    static async filterCashEligibleDrivers(driverIds: string[]): Promise<string[]> {
        if (driverIds.length === 0) return [];
        const wallets = await AppDataSource.getRepository(Wallet).findBy(
            driverIds.map(id => ({ userId: id }))
        );
        const debtMap = new Map<string, number>(
            wallets.map(w => [w.userId, Number(w.driverCommissionDebt)])
        );
        return driverIds.filter(id => (debtMap.get(id) ?? 0) < DEBT_CASH_BLOCK);
    }

    /**
     * Finalize a Paystack top-up. Credits either passenger or driver balance depending on metadata.role.
     */
    static async finalizeTopup(reference: string, amount: number): Promise<void> {
        await AppDataSource.transaction(async (manager) => {
            const tx = await manager.findOne(Transaction, { where: { reference }, lock: { mode: "pessimistic_write" } });
            if (!tx) throw new Error("Transaction record not found");
            if (tx.status === TransactionStatus.SUCCESS) return;

            tx.status = TransactionStatus.SUCCESS;
            await manager.save(tx);

            const balanceType = ((tx as any).metadata?.role ?? (tx as any).role) === 'driver'
                ? BalanceType.DRIVER_AVAILABLE
                : BalanceType.PASSENGER;

            await this.mutateBalance(tx.userId, amount, balanceType, TransactionType.TOPUP, { reference });
        });
    }

    /**
     * Create a payout request: debit driverAvailableBalance, create PayoutRecord in PENDING state.
     * Returns the new PayoutRecord. Admin must then mark it SUCCESS via Paystack Transfer or manual bank transfer.
     */
    static async initiatePayout(driverId: string, amount: number, bankCode: string, accountNumber: string): Promise<any> {
        return await AppDataSource.transaction(async (manager) => {
            const wallet = await manager.findOne(Wallet, {
                where: { userId: driverId },
                lock: { mode: 'pessimistic_write' }
            });
            if (!wallet) throw new Error('Wallet not found');

            const available = Number(wallet.driverAvailableBalance);
            if (available < amount) {
                throw new Error(`Insufficient balance: available ₦${available}, requested ₦${amount}`);
            }
            if (amount <= 0) throw new Error('Amount must be positive');

            const pendingBefore = Number(wallet.driverPendingBalance);
            wallet.driverAvailableBalance = available - amount;
            wallet.driverPendingBalance   = pendingBefore + amount;
            await manager.save(wallet);

            // Debit available
            await manager.save(manager.create(LedgerEntry, {
                walletId: driverId,
                balanceType: BalanceType.DRIVER_AVAILABLE,
                transactionType: TransactionType.PAYOUT,
                amount: -amount,
                balanceBefore: available,
                balanceAfter: wallet.driverAvailableBalance,
                metadata: { source: 'payout_request', bankCode, accountNumber },
            }));

            // Credit pending (held until admin confirms transfer)
            await manager.save(manager.create(LedgerEntry, {
                walletId: driverId,
                balanceType: BalanceType.DRIVER_PENDING,
                transactionType: TransactionType.PAYOUT,
                amount,
                balanceBefore: pendingBefore,
                balanceAfter: wallet.driverPendingBalance,
                metadata: { source: 'payout_request', bankCode, accountNumber },
            }));

            const payout = manager.create(PayoutRecord, {
                driverId,
                amount,
                bankCode,
                accountNumber,
                status: PayoutStatus.PENDING,
            });
            await manager.save(payout);

            await manager.save(manager.create(AuditLog, {
                adminId: `driver:${driverId}`,
                action: 'PAYOUT_REQUESTED',
                entityType: 'PAYOUT',
                entityId: payout.id,
                details: { amount, bankCode, accountNumber },
            }));

            return payout;
        });
    }

    /**
     * Apply driverAvailableBalance directly against commission debt.
     * Called when driver taps "PAY NOW" and already has wallet funds.
     * Returns { applied, remainingDebt }.
     */
    static async repayDebtFromBalance(driverId: string): Promise<{ applied: number; remainingDebt: number }> {
        return await AppDataSource.transaction(async (manager) => {
            const wallet = await manager.findOne(Wallet, {
                where: { userId: driverId },
                lock: { mode: "pessimistic_write" }
            });
            if (!wallet) return { applied: 0, remainingDebt: 0 };

            const available = Number(wallet.driverAvailableBalance);
            const debt      = Number(wallet.driverCommissionDebt);
            if (debt <= 0 || available <= 0) return { applied: 0, remainingDebt: debt };

            const applied = Math.min(available, debt);

            wallet.driverAvailableBalance = available - applied;
            wallet.driverCommissionDebt   = debt - applied;
            await manager.save(wallet);

            await manager.save(manager.create(LedgerEntry, {
                walletId: driverId,
                balanceType: BalanceType.DRIVER_AVAILABLE,
                transactionType: TransactionType.DEBT_RECOVERY,
                amount: -applied,
                balanceBefore: available,
                balanceAfter: wallet.driverAvailableBalance,
                metadata: { source: 'manual_repay', debtBefore: debt, applied },
            }));

            await manager.save(manager.create(LedgerEntry, {
                walletId: driverId,
                balanceType: BalanceType.DRIVER_COMMISSION_DEBT,
                transactionType: TransactionType.DEBT_RECOVERY,
                amount: -applied,
                balanceBefore: debt,
                balanceAfter: wallet.driverCommissionDebt,
                metadata: { source: 'manual_repay', applied },
            }));

            return { applied, remainingDebt: wallet.driverCommissionDebt };
        });
    }

    /**
     * Post ride financials on completion.
     *
     * Cash ride:
     *   1. Record CASH_RECEIVED (driver acknowledges physical collection of full fare).
     *   2. Record CASH_EXTERNALIZED (the amount leaves the platform ledger immediately).
     *   3. Deduct 10% commission — try driverAvailableBalance first; remainder becomes debt.
     *
     * Wallet ride:
     *   1. Debit passenger wallet.
     *   2. Credit driver 90% net.
     *   3. Apply debt recovery from those earnings if driver has outstanding debt.
     */
    static async postRideFinancials(data: {
        rideId: string;
        passengerId: string;
        driverId: string;
        totalFare: number;
        isCash: boolean;
    }): Promise<void> {
        const pricingConfig = await SettingService.getPricingConfig();
        const pct = pricingConfig.platformFeePercent;
        const feeFactor = 1 + (pct / 100);

        const driverNetAmount  = Math.round((data.totalFare / feeFactor) * 100) / 100;
        const commissionAmount = Math.round((data.totalFare - driverNetAmount) * 100) / 100;

        if (data.isCash) {
            await this._postCashRideFinancials(data.rideId, data.driverId, data.totalFare, commissionAmount);
        } else {
            await this._postWalletRideFinancials(
                data.rideId, data.passengerId, data.driverId, data.totalFare, driverNetAmount, commissionAmount
            );
        }
    }


    private static async _postCashRideFinancials(
        rideId: string,
        driverId: string,
        totalFare: number,
        commissionAmount: number
    ): Promise<void> {
        await AppDataSource.transaction(async (manager) => {
            let wallet = await manager.findOne(Wallet, {
                where: { userId: driverId },
                lock: { mode: "pessimistic_write" }
            });
            if (!wallet) {
                wallet = manager.create(Wallet, { userId: driverId });
                await manager.save(wallet);
            }

            const meta = { rideId, fare: totalFare };
            const available = Number(wallet.driverAvailableBalance);

            // 1. CASH_RECEIVED — informational audit entry only. The driver physically
            //    collected this fare in cash; it is not deposited into the platform wallet,
            //    so the balance does not change here (balanceBefore == balanceAfter).
            await manager.save(manager.create(LedgerEntry, {
                walletId: driverId,
                balanceType: BalanceType.DRIVER_AVAILABLE,
                transactionType: TransactionType.CASH_RECEIVED,
                amount: totalFare,
                balanceBefore: available,
                balanceAfter: available,
                metadata: { ...meta, note: 'Physical cash collected by driver — audit record' },
            }));

            // 2. COMMISSION_CHARGE — deduct platform commission from the driver's pre-existing
            //    wallet balance. If the balance is insufficient, deduct what is available and
            //    push the shortfall into commission debt.
            const canPay  = Math.min(available, commissionAmount);
            const shortfall = Math.round((commissionAmount - canPay) * 100) / 100;

            if (canPay > 0) {
                const availAfter = Math.round((available - canPay) * 100) / 100;
                wallet.driverAvailableBalance = availAfter;
                await manager.save(wallet);
                await manager.save(manager.create(LedgerEntry, {
                    walletId: driverId,
                    balanceType: BalanceType.DRIVER_AVAILABLE,
                    transactionType: TransactionType.COMMISSION_CHARGE,
                    amount: -canPay,
                    balanceBefore: available,
                    balanceAfter: availAfter,
                    metadata: { ...meta, commissionAmount, paid: canPay, shortfall },
                }));
            }

            if (shortfall > 0) {
                const debtBefore = Number(wallet.driverCommissionDebt);
                const debtAfter  = Math.round((debtBefore + shortfall) * 100) / 100;
                wallet.driverCommissionDebt = debtAfter;
                await manager.save(wallet);
                await manager.save(manager.create(LedgerEntry, {
                    walletId: driverId,
                    balanceType: BalanceType.DRIVER_COMMISSION_DEBT,
                    transactionType: TransactionType.COMMISSION_CHARGE,
                    amount: shortfall,
                    balanceBefore: debtBefore,
                    balanceAfter: debtAfter,
                    metadata: { ...meta, commissionAmount, paid: canPay, shortfall },
                }));
            }

            // 3. Platform revenue
            await manager.save(manager.create(LedgerEntry, {
                walletId: 'PLATFORM',
                balanceType: BalanceType.PLATFORM_REVENUE,
                transactionType: TransactionType.COMMISSION_CREDIT,
                amount: commissionAmount,
                balanceBefore: 0,
                balanceAfter: 0,
                metadata: { rideId, source: 'cash_ride', commissionAmount, totalFare },
            }));
        });
    }

    private static async _postWalletRideFinancials(
        rideId: string,
        passengerId: string,
        driverId: string,
        totalFare: number,
        driverNetAmount: number,
        commissionAmount: number
    ): Promise<void> {
        await AppDataSource.transaction(async (manager) => {
            // 1. Debit passenger
            const passengerWallet = await manager.findOne(Wallet, {
                where: { userId: passengerId },
                lock: { mode: "pessimistic_write" }
            });
            if (!passengerWallet) throw new Error("Passenger wallet not found");

            const paxBefore = Number(passengerWallet.passengerBalance);
            if (paxBefore < totalFare) {
                throw new Error(`Insufficient balance: has ₦${paxBefore}, needs ₦${totalFare}`);
            }

            passengerWallet.passengerBalance = paxBefore - totalFare;
            await manager.save(passengerWallet);
            await manager.save(manager.create(LedgerEntry, {
                walletId: passengerId,
                balanceType: BalanceType.PASSENGER,
                transactionType: TransactionType.TRIP_PAYMENT,
                amount: -totalFare,
                balanceBefore: paxBefore,
                balanceAfter: passengerWallet.passengerBalance,
                metadata: { rideId },
            }));

            // 2. Credit driver net earnings
            let driverWallet = await manager.findOne(Wallet, {
                where: { userId: driverId },
                lock: { mode: "pessimistic_write" }
            });
            if (!driverWallet) {
                driverWallet = manager.create(Wallet, { userId: driverId });
            }

            const driverBefore = Number(driverWallet.driverAvailableBalance);
            driverWallet.driverAvailableBalance = driverBefore + driverNetAmount;
            await manager.save(driverWallet);
            await manager.save(manager.create(LedgerEntry, {
                walletId: driverId,
                balanceType: BalanceType.DRIVER_AVAILABLE,
                transactionType: TransactionType.TRIP_PAYMENT,
                amount: driverNetAmount,
                balanceBefore: driverBefore,
                balanceAfter: driverWallet.driverAvailableBalance,
                metadata: { rideId, commission: commissionAmount },
            }));

            // 3. Debt recovery — if driver owes, deduct from freshly credited earnings
            const debtBefore = Number(driverWallet.driverCommissionDebt);
            if (debtBefore > 0) {
                const recovered = Math.min(debtBefore, driverNetAmount);
                const availAfterRecovery = Number(driverWallet.driverAvailableBalance) - recovered;

                driverWallet.driverAvailableBalance = availAfterRecovery;
                driverWallet.driverCommissionDebt   = debtBefore - recovered;
                await manager.save(driverWallet);

                await manager.save(manager.create(LedgerEntry, {
                    walletId: driverId,
                    balanceType: BalanceType.DRIVER_AVAILABLE,
                    transactionType: TransactionType.DEBT_RECOVERY,
                    amount: -recovered,
                    balanceBefore: Number(driverWallet.driverAvailableBalance) + recovered,
                    balanceAfter: availAfterRecovery,
                    metadata: { rideId, debtBefore, recovered, debtAfter: driverWallet.driverCommissionDebt },
                }));

                await manager.save(manager.create(LedgerEntry, {
                    walletId: driverId,
                    balanceType: BalanceType.DRIVER_COMMISSION_DEBT,
                    transactionType: TransactionType.DEBT_RECOVERY,
                    amount: -recovered,
                    balanceBefore: debtBefore,
                    balanceAfter: driverWallet.driverCommissionDebt,
                    metadata: { rideId, recovered },
                }));
            }

            // Platform revenue: commission on wallet rides is collected immediately from fare
            await manager.save(manager.create(LedgerEntry, {
                walletId: 'PLATFORM',
                balanceType: BalanceType.PLATFORM_REVENUE,
                transactionType: TransactionType.COMMISSION_CREDIT,
                amount: commissionAmount,
                balanceBefore: 0,
                balanceAfter: 0,
                metadata: { rideId, source: 'wallet_ride', commissionAmount, totalFare },
            }));
        });
    }
}
