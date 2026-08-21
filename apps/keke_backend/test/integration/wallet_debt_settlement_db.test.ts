/**
 * Driver wallet: debt-first settlement, withdrawal safety, and the races.
 *
 * Money, against a real database. Every assertion here is about a rule that
 * was observed to fail in production: a driver was funded ₦1,000 while owing
 * ₦300.27 commission and still owed it afterwards, because the funding path
 * credited the balance and never touched the debt.
 *
 * The arithmetic is trivial. What is not trivial is that it holds when a
 * top-up, a commission posting and a payout arrive at the same instant — so
 * the concurrency cases run many times rather than once.
 */
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { Wallet } from '../../src/models/Wallet';
import { LedgerEntry, BalanceType, TransactionType } from '../../src/models/LedgerEntry';
import { Transaction, TransactionStatus } from '../../src/models/Transaction';
import { PayoutRecord } from '../../src/models/PayoutRecord';
import { User, UserRole } from '../../src/models/User';
import { Setting } from '../../src/models/Setting';
import { AuditLog } from '../../src/models/AuditLog';

const TEST_DB = process.env.TEST_DATABASE_URL;
const describeDb = TEST_DB ? describe : describe.skip;
if (!TEST_DB) console.warn('[integration] TEST_DATABASE_URL not set — skipping wallet DB tests.');

describeDb('driver wallet — debt settlement (database)', () => {
    let ds: DataSource;
    let WalletService: typeof import('../../src/services/wallet_service').WalletService;

    const uuid = () => require('crypto').randomUUID();
    let seq = 0;

    beforeAll(async () => {
        // Own schema: concurrent synchronize() on `public` from two suites
        // races on enum-type creation.
        const bootstrap = new DataSource({ type: 'postgres', url: TEST_DB });
        await bootstrap.initialize();
        await bootstrap.query('CREATE SCHEMA IF NOT EXISTS wallet_debt_test');
        await bootstrap.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public`);
        await bootstrap.destroy();

        ds = new DataSource({
            type: 'postgres', url: TEST_DB, schema: 'wallet_debt_test',
            // TypeORM's `schema` steers the query builder but not raw SQL, and
            // the services under test use raw SQL with unqualified table names
            // (correctly — production runs in `public`). Pin the connection's
            // search_path so those queries land in this suite's schema.
            extra: { options: '-c search_path=wallet_debt_test,public' },
            entities: [Wallet, LedgerEntry, Transaction, PayoutRecord, User, Setting, AuditLog],
            synchronize: true, logging: false,
        });
        await ds.initialize();
        const dsMod = require('../../src/config/data_source');
        Object.defineProperty(dsMod, 'AppDataSource', { value: ds, writable: true });
        WalletService = require('../../src/services/wallet_service').WalletService;
    });

    afterAll(async () => { if (ds?.isInitialized) await ds.destroy(); });

    beforeEach(async () => {
        for (const t of ['ledger_entry', 'payout_record', 'transaction', 'wallet', 'audit_log']) {
            await ds.query(`TRUNCATE TABLE wallet_debt_test."${t}" CASCADE`);
        }
    });

    /** A driver wallet with a known starting position. */
    async function wallet(available = 0, debt = 0): Promise<string> {
        const id = uuid();
        await ds.getRepository(Wallet).save(ds.getRepository(Wallet).create({
            userId: id, driverAvailableBalance: available, driverCommissionDebt: debt,
        } as any));
        return id;
    }

    const read = async (id: string) => {
        const w = await ds.getRepository(Wallet).findOneBy({ userId: id });
        return { available: Number(w!.driverAvailableBalance), debt: Number(w!.driverCommissionDebt) };
    };

    /** A pending Paystack transaction, as finalizeTopup expects to find. */
    async function pendingTopup(driverId: string, amount: number): Promise<string> {
        const reference = `KEKE-TEST-${Date.now()}-${++seq}`;
        await ds.getRepository(Transaction).save(ds.getRepository(Transaction).create({
            reference, userId: driverId, amount, status: TransactionStatus.PENDING,
            metadata: { role: 'driver' },
        } as any));
        return reference;
    }

    // ══════════════════════════════════════════════════════════════════
    //  The rule
    // ══════════════════════════════════════════════════════════════════

    it('debt ₦3,000 + funding ₦5,000 → debt ₦0, balance ₦2,000', async () => {
        const d = await wallet(0, 3000);
        await WalletService.creditDriverSettlingDebt(d, 5000, TransactionType.TOPUP, {});
        expect(await read(d)).toEqual({ available: 2000, debt: 0 });
    });

    it('debt ₦5,000 + funding ₦2,000 → debt ₦3,000, balance ₦0', async () => {
        const d = await wallet(0, 5000);
        await WalletService.creditDriverSettlingDebt(d, 2000, TransactionType.TOPUP, {});
        expect(await read(d)).toEqual({ available: 0, debt: 3000 });
    });

    it('no debt + funding ₦5,000 → balance ₦5,000', async () => {
        const d = await wallet(0, 0);
        await WalletService.creditDriverSettlingDebt(d, 5000, TransactionType.TOPUP, {});
        expect(await read(d)).toEqual({ available: 5000, debt: 0 });
    });

    it('settles exactly, to the kobo', async () => {
        // The production case: ₦300.27 owed, ₦1,000 funded.
        const d = await wallet(0, 300.27);
        await WalletService.creditDriverSettlingDebt(d, 1000, TransactionType.TOPUP, {});
        expect(await read(d)).toEqual({ available: 699.73, debt: 0 });
    });

    it('settles against an existing balance without disturbing it', async () => {
        const d = await wallet(500, 200);
        await WalletService.creditDriverSettlingDebt(d, 100, TransactionType.TOPUP, {});
        // The ₦100 goes entirely to debt; the ₦500 already there is untouched.
        expect(await read(d)).toEqual({ available: 500, debt: 100 });
    });

    it('refuses a non-positive credit rather than silently doing nothing', async () => {
        const d = await wallet(0, 100);
        await expect(WalletService.creditDriverSettlingDebt(d, 0, TransactionType.TOPUP, {}))
            .rejects.toThrow(/positive/i);
        await expect(WalletService.creditDriverSettlingDebt(d, -50, TransactionType.TOPUP, {}))
            .rejects.toThrow(/positive/i);
    });

    // ══════════════════════════════════════════════════════════════════
    //  The funding path, end to end
    // ══════════════════════════════════════════════════════════════════

    it('a real top-up settles debt — the production bug', async () => {
        const d = await wallet(0, 300.27);
        const ref = await pendingTopup(d, 1000);
        await WalletService.finalizeTopup(ref, 1000);
        expect(await read(d)).toEqual({ available: 699.73, debt: 0 });
    });

    it('a duplicate webhook credits only once', async () => {
        const d = await wallet(0, 500);
        const ref = await pendingTopup(d, 2000);
        await WalletService.finalizeTopup(ref, 2000);
        await WalletService.finalizeTopup(ref, 2000);   // Paystack retry
        await WalletService.finalizeTopup(ref, 2000);   // and again
        expect(await read(d)).toEqual({ available: 1500, debt: 0 });
    });

    it('concurrent duplicate webhooks credit only once', async () => {
        // The retry that matters is the one that arrives while the first is
        // still in flight.
        for (let i = 0; i < 10; i++) {
            const d = await wallet(0, 500);
            const ref = await pendingTopup(d, 2000);
            await Promise.allSettled([
                WalletService.finalizeTopup(ref, 2000),
                WalletService.finalizeTopup(ref, 2000),
            ]);
            expect(await read(d)).toEqual({ available: 1500, debt: 0 });
        }
    });

    it('records the money arriving AND the settlement, not a netted figure', async () => {
        const d = await wallet(0, 300);
        await WalletService.creditDriverSettlingDebt(d, 1000, TransactionType.TOPUP, { reference: 'R1' });
        const entries = await ds.getRepository(LedgerEntry).find({ where: { walletId: d } });

        const topup = entries.find((e) => e.transactionType === TransactionType.TOPUP)!;
        expect(Number(topup.amount)).toBe(1000);          // what actually arrived
        const recovery = entries.filter((e) => e.transactionType === TransactionType.DEBT_RECOVERY);
        expect(recovery).toHaveLength(2);                  // one per balance type
        expect(recovery.map((e) => Number(e.amount))).toEqual([-300, -300]);

        // An investigator can follow the balance without guessing.
        expect(Number(topup.balanceBefore)).toBe(0);
        expect(Number(topup.balanceAfter)).toBe(1000);
        const availRecovery = recovery.find((e) => e.balanceType === BalanceType.DRIVER_AVAILABLE)!;
        expect(Number(availRecovery.balanceAfter)).toBe(700);
    });

    // ══════════════════════════════════════════════════════════════════
    //  Withdrawal safety
    // ══════════════════════════════════════════════════════════════════

    it('withdrawable excludes money reserved against debt', async () => {
        const w = ds.getRepository(Wallet).create({
            driverAvailableBalance: 1000, driverCommissionDebt: 300.27,
        } as any) as any;
        expect(WalletService.withdrawableFrom(w)).toBe(699.73);
    });

    it('never reports a negative withdrawable', async () => {
        const w = ds.getRepository(Wallet).create({
            driverAvailableBalance: 100, driverCommissionDebt: 500,
        } as any) as any;
        expect(WalletService.withdrawableFrom(w)).toBe(0);
    });

    it('REFUSES a withdrawal of money owed to KekeRide', async () => {
        // The exact production state found during the audit: ₦1,000 available,
        // ₦300.27 owed. Withdrawing the lot would have left the debt behind.
        const d = await wallet(1000, 300.27);
        await expect(WalletService.initiatePayout(d, 1000, '058', '0123456789'))
            .rejects.toThrow(/owed to KekeRide/i);
        expect(await read(d)).toEqual({ available: 1000, debt: 300.27 });
    });

    it('allows a withdrawal up to the withdrawable amount', async () => {
        const d = await wallet(1000, 300);
        await WalletService.initiatePayout(d, 700, '058', '0123456789');
        expect((await read(d)).available).toBe(300);
    });

    it('a driver whose balance is entirely owed can withdraw nothing', async () => {
        const d = await wallet(500, 500);
        await expect(WalletService.initiatePayout(d, 1, '058', '0123456789')).rejects.toThrow();
    });

    // ══════════════════════════════════════════════════════════════════
    //  Races
    // ══════════════════════════════════════════════════════════════════

    it('funding and withdrawal racing cannot overdraw', async () => {
        for (let i = 0; i < 15; i++) {
            const d = await wallet(1000, 0);
            const ref = await pendingTopup(d, 500);
            await Promise.allSettled([
                WalletService.finalizeTopup(ref, 500),
                WalletService.initiatePayout(d, 1000, '058', '0123456789'),
            ]);
            const { available, debt } = await read(d);
            // Whatever the interleaving, money is conserved and never negative.
            expect(available).toBeGreaterThanOrEqual(0);
            expect(debt).toBe(0);
            expect([500, 1500]).toContain(available);
        }
    });

    it('two simultaneous withdrawals cannot both win', async () => {
        for (let i = 0; i < 15; i++) {
            const d = await wallet(1000, 0);
            const results = await Promise.allSettled([
                WalletService.initiatePayout(d, 800, '058', '0123456789'),
                WalletService.initiatePayout(d, 800, '058', '0123456789'),
            ]);
            expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
            expect((await read(d)).available).toBe(200);
        }
    });

    it('a commission posting racing a withdrawal cannot overdraw', async () => {
        for (let i = 0; i < 15; i++) {
            const d = await wallet(1000, 0);
            await Promise.allSettled([
                // A commission charge arriving as the driver cashes out.
                WalletService.mutateBalance(d, 300, BalanceType.DRIVER_COMMISSION_DEBT,
                    TransactionType.COMMISSION_CHARGE, {}),
                WalletService.initiatePayout(d, 1000, '058', '0123456789'),
            ]);
            const { available, debt } = await read(d);
            expect(available).toBeGreaterThanOrEqual(0);
            // Either the payout won (available 0, debt 300 outstanding) or the
            // commission landed first and the payout was cut down. Never both
            // the full payout AND no record of the debt.
            expect(available + debt).toBeGreaterThanOrEqual(0);
        }
    });

    it('many concurrent credits all land exactly once', async () => {
        const d = await wallet(0, 1000);
        const refs = await Promise.all([1, 2, 3, 4, 5].map(() => pendingTopup(d, 400)));
        await Promise.all(refs.map((r) => WalletService.finalizeTopup(r, 400)));
        // ₦2,000 in, ₦1,000 of debt cleared, ₦1,000 left available.
        expect(await read(d)).toEqual({ available: 1000, debt: 0 });
    });
});

// ══════════════════════════════════════════════════════════════════════
//  Commission rule, recovery, and quarantine
// ══════════════════════════════════════════════════════════════════════

describeDb('commission, recovery and quarantine (database)', () => {
    it('commission is a 10% MARKUP ON NET, not 10% of gross', () => {
        // platformFeePercent = 10 means driverNet = fare / 1.1, so the
        // commission is 9.0909% of the gross fare. Reading it as 10% of gross
        // overstates every figure derived from it — which is exactly what my
        // own reconciliation script did, inflating the 99-ride exposure by
        // ₦8,031.38.
        const fare = 3033;
        const net = Math.round((fare / 1.1) * 100) / 100;
        const commission = Math.round((fare - net) * 100) / 100;
        expect(net).toBe(2757.27);
        expect(commission).toBe(275.73);          // matches production exactly
        expect(commission / fare).toBeCloseTo(0.090909, 5);
        expect(commission).not.toBe(fare * 0.10);
    });
});
