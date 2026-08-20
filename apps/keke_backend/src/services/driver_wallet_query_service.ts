/**
 * Read side of Driver Wallets, for finance and operations investigation.
 *
 * Server-side paging, filtering and search — the browser never receives the
 * whole wallet table, and the aggregates are computed in Postgres rather than
 * by summing rows in JavaScript.
 *
 * ── Derived, not stored ──────────────────────────────────────────────────
 * Totals (funded, charged, withdrawn) come from the LEDGER, not from counters
 * kept alongside the balance. A counter can drift from the entries that
 * produced it; a SUM cannot.
 */
import { AppDataSource } from '../config/data_source';
import { Wallet } from '../models/Wallet';
import { LedgerEntry, BalanceType, TransactionType } from '../models/LedgerEntry';
import { User } from '../models/User';
import { DriverProfile } from '../models/DriverProfile';
import { WalletService } from './wallet_service';
import { maskPhone } from './dispatch_monitor_query_service';
import { In } from 'typeorm';

const MAX_PAGE = 100;

export type WalletFilter =
    | 'all' | 'in_debt' | 'positive_balance' | 'zero' | 'recently_funded' | 'recently_active';

export interface DriverWalletRow {
    driverId: string;
    name: string;
    phoneMasked: string | null;
    vehiclePlate: string | null;
    unitNumber: string | null;
    availableBalance: number;
    outstandingDebt: number;
    withdrawable: number;
    pendingBalance: number;
    totalFunded: number;
    totalCommissionCharged: number;
    totalWithdrawn: number;
    lastTransactionAt: string | null;
    lastTransactionType: string | null;
    lastFundedAt: string | null;
    walletStatus: 'in_debt' | 'in_credit' | 'zero';
}

export class DriverWalletQueryService {
    static async list(opts: {
        q?: string;
        filter?: WalletFilter;
        page?: number;
        pageSize?: number;
    } = {}): Promise<{ rows: DriverWalletRow[]; total: number; page: number; pageSize: number }> {
        const pageSize = Math.min(Math.max(Number(opts.pageSize) || 25, 1), MAX_PAGE);
        const page = Math.max(Number(opts.page) || 1, 1);
        const filter = opts.filter ?? 'all';

        // Identities are resolved FIRST when searching, so the wallet query can
        // then use its indexed key — the same reasoning as Ride Operations.
        let idFilter: string[] | null = null;
        if (opts.q?.trim()) {
            const like = `%${opts.q.trim()}%`;
            const digits = opts.q.replace(/\D/g, '');
            const users = await AppDataSource.getRepository(User).createQueryBuilder('u')
                .select('u.id', 'id')
                .where(`u."firstName" ILIKE :like OR u."lastName" ILIKE :like
                        OR (u."firstName" || ' ' || u."lastName") ILIKE :like
                        OR u.email ILIKE :like
                        ${digits.length >= 4 ? `OR regexp_replace(u.phone, '\\D', '', 'g') LIKE :digits` : ''}`,
                    { like, digits: `%${digits}%` })
                .limit(500).getRawMany();
            const profiles = await AppDataSource.getRepository(DriverProfile).createQueryBuilder('d')
                .select('d.userId', 'id')
                .where(`d."firstName" ILIKE :like OR d."lastName" ILIKE :like
                        OR d."vehiclePlate" ILIKE :like OR d."unitNumber" ILIKE :like`, { like })
                .limit(500).getRawMany();
            idFilter = [...new Set([...users, ...profiles].map((r) => String(r.id)))];
            if (idFilter.length === 0) return { rows: [], total: 0, page, pageSize };
        }

        const qb = AppDataSource.getRepository(Wallet).createQueryBuilder('w');
        if (idFilter) qb.andWhere('w."userId" IN (:...ids)', { ids: idFilter });

        switch (filter) {
            case 'in_debt':
                qb.andWhere('w."driverCommissionDebt" > 0'); break;
            case 'positive_balance':
                qb.andWhere('w."driverAvailableBalance" > 0'); break;
            case 'zero':
                qb.andWhere('w."driverAvailableBalance" = 0 AND w."driverCommissionDebt" = 0'); break;
            case 'recently_funded':
                qb.andWhere(`EXISTS (SELECT 1 FROM ledger_entry le WHERE le."walletId" = w."userId"
                             AND le."transactionType" = 'topup'
                             AND le."createdAt" > now() - interval '7 days')`); break;
            case 'recently_active':
                qb.andWhere(`EXISTS (SELECT 1 FROM ledger_entry le WHERE le."walletId" = w."userId"
                             AND le."createdAt" > now() - interval '7 days')`); break;
        }

        const [wallets, total] = await qb
            .orderBy('w."driverCommissionDebt"', 'DESC')
            .addOrderBy('w."driverAvailableBalance"', 'DESC')
            .skip((page - 1) * pageSize).take(pageSize)
            .getManyAndCount();

        if (wallets.length === 0) return { rows: [], total, page, pageSize };
        const ids = wallets.map((w) => w.userId);

        const [users, profiles, totals, lastEntries] = await Promise.all([
            AppDataSource.getRepository(User).find({ where: { id: In(ids) } }),
            AppDataSource.getRepository(DriverProfile).find({ where: { userId: In(ids) } }),
            AppDataSource.getRepository(LedgerEntry).createQueryBuilder('le')
                .select('le."walletId"', 'walletId')
                .addSelect(`SUM(le.amount) FILTER (WHERE le."transactionType"='topup')`, 'funded')
                .addSelect(`SUM(ABS(le.amount)) FILTER (WHERE le."transactionType"='commission_charge'
                            AND le."balanceType"='driver_commission_debt')`, 'charged')
                .addSelect(`SUM(ABS(le.amount)) FILTER (WHERE le."transactionType"='payout'
                            AND le."balanceType"='driver_available' AND le.amount < 0)`, 'withdrawn')
                .addSelect(`MAX(le."createdAt") FILTER (WHERE le."transactionType"='topup')`, 'lastFunded')
                .where('le."walletId" IN (:...ids)', { ids })
                .groupBy('le."walletId"').getRawMany(),
            AppDataSource.getRepository(LedgerEntry).createQueryBuilder('le')
                .distinctOn(['le."walletId"'])
                .where('le."walletId" IN (:...ids)', { ids })
                .orderBy('le."walletId"').addOrderBy('le."createdAt"', 'DESC')
                .getMany(),
        ]);

        const userById = new Map(users.map((u) => [u.id, u]));
        const profileById = new Map(profiles.map((p) => [p.userId, p]));
        const totalsById = new Map(totals.map((t: any) => [t.walletId, t]));
        const lastById = new Map(lastEntries.map((e) => [e.walletId, e]));

        const rows: DriverWalletRow[] = wallets.map((w) => {
            const u = userById.get(w.userId);
            const p = profileById.get(w.userId);
            const t = totalsById.get(w.userId);
            const last = lastById.get(w.userId);
            const available = Number(w.driverAvailableBalance);
            const debt = Number(w.driverCommissionDebt);

            return {
                driverId: w.userId,
                name: [p?.firstName ?? u?.firstName, p?.lastName ?? u?.lastName]
                    .filter(Boolean).join(' ') || 'Unknown',
                phoneMasked: maskPhone(u?.phone),
                vehiclePlate: p?.vehiclePlate ?? null,
                unitNumber: p?.unitNumber ?? null,
                availableBalance: available,
                outstandingDebt: debt,
                withdrawable: WalletService.withdrawableFrom(w),
                pendingBalance: Number(w.driverPendingBalance),
                totalFunded: Number(t?.funded ?? 0),
                totalCommissionCharged: Number(t?.charged ?? 0),
                totalWithdrawn: Number(t?.withdrawn ?? 0),
                lastTransactionAt: last ? new Date(last.createdAt).toISOString() : null,
                lastTransactionType: last?.transactionType ?? null,
                lastFundedAt: t?.lastFunded ? new Date(t.lastFunded).toISOString() : null,
                walletStatus: debt > 0 ? 'in_debt' : available > 0 ? 'in_credit' : 'zero',
            };
        });

        return { rows, total, page, pageSize };
    }

    /** The full ledger for one driver — every entry, never a computed total. */
    static async ledger(driverId: string, limit = 200) {
        const [wallet, entries, user, profile] = await Promise.all([
            AppDataSource.getRepository(Wallet).findOneBy({ userId: driverId }),
            AppDataSource.getRepository(LedgerEntry).find({
                where: { walletId: driverId },
                order: { createdAt: 'DESC' },
                take: Math.min(limit, 500),
            }),
            AppDataSource.getRepository(User).findOne({ where: { id: driverId } }),
            AppDataSource.getRepository(DriverProfile).findOneBy({ userId: driverId }),
        ]);
        if (!wallet) return null;

        return {
            driver: {
                driverId,
                name: [profile?.firstName ?? user?.firstName, profile?.lastName ?? user?.lastName]
                    .filter(Boolean).join(' ') || 'Unknown',
                phoneMasked: maskPhone(user?.phone),
                vehiclePlate: profile?.vehiclePlate ?? null,
                unitNumber: profile?.unitNumber ?? null,
            },
            wallet: {
                availableBalance: Number(wallet.driverAvailableBalance),
                outstandingDebt: Number(wallet.driverCommissionDebt),
                pendingBalance: Number(wallet.driverPendingBalance),
                withdrawable: WalletService.withdrawableFrom(wallet),
            },
            entries: entries.map((e) => ({
                id: e.id,
                at: new Date(e.createdAt).toISOString(),
                balanceType: e.balanceType,
                transactionType: e.transactionType,
                amount: Number(e.amount),
                balanceBefore: Number(e.balanceBefore),
                balanceAfter: Number(e.balanceAfter),
                // An informational row records a fact without moving money —
                // cash the driver physically collected, or platform revenue.
                // Rendering it as a balance change would mislead an
                // investigator into thinking the wallet moved.
                informational: Number(e.balanceBefore) === Number(e.balanceAfter),
                rideId: (e.metadata as any)?.rideId ?? null,
                reference: (e.metadata as any)?.reference ?? null,
                source: (e.metadata as any)?.source ?? null,
                metadata: e.metadata ?? null,
            })),
        };
    }
}
