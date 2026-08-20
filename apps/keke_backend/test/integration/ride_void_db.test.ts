/**
 * Voiding a ride: the seven properties a void must have.
 *
 * Field-training rides are requested, accepted, started and ended without a
 * genuine passenger journey, then voided by an admin so they do not count.
 * That only works if a void is airtight — and it was not. Void set
 * `paymentFailed = true`, the identical flag a genuinely failed posting sets,
 * so the automatic recovery worker could not tell a training ride from a
 * billing failure and would have charged the driver for being taught.
 *
 * Each test below is one property, stated the way it should be true.
 */
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { Wallet } from '../../src/models/Wallet';
import { LedgerEntry, BalanceType, TransactionType } from '../../src/models/LedgerEntry';
import { Transaction } from '../../src/models/Transaction';
import { PayoutRecord } from '../../src/models/PayoutRecord';
import { User } from '../../src/models/User';
import { Setting } from '../../src/models/Setting';
import { AuditLog } from '../../src/models/AuditLog';
import { Ride } from '../../src/models/Ride';

const TEST_DB = process.env.TEST_DATABASE_URL;
const describeDb = TEST_DB ? describe : describe.skip;
if (!TEST_DB) console.warn('[integration] TEST_DATABASE_URL not set — skipping void tests.');

describeDb('voided ride — financial properties (database)', () => {
    let ds: DataSource;
    let WalletService: typeof import('../../src/services/wallet_service').WalletService;

    const uuid = () => require('crypto').randomUUID();
    const FARE = 1100;                 // → net 1000, commission 100 at 10% markup
    const COMMISSION = 100;

    beforeAll(async () => {
        // Own schema, like the other integration suites. Two suites calling
        // synchronize() on `public` at the same time race to create the same
        // enum types and one of them loses on pg_type_typname_nsp_index.
        const bootstrap = new DataSource({ type: 'postgres', url: TEST_DB });
        await bootstrap.initialize();
        await bootstrap.query('CREATE SCHEMA IF NOT EXISTS ride_void_test');
        await bootstrap.destroy();

        ds = new DataSource({
            type: 'postgres', url: TEST_DB, schema: 'ride_void_test',
            // TypeORM's `schema` steers the query builder but not raw SQL, and
            // the services under test use raw SQL with unqualified table names
            // (correctly — production runs in `public`). Pin the connection's
            // search_path so those queries land in this suite's schema.
            extra: { options: '-c search_path=ride_void_test,public' },
            entities: [Wallet, LedgerEntry, Transaction, PayoutRecord, User, Setting, AuditLog, Ride],
            synchronize: true, logging: false,
        });
        await ds.initialize();
        const dsMod = require('../../src/config/data_source');
        Object.defineProperty(dsMod, 'AppDataSource', { value: ds, writable: true });
        WalletService = require('../../src/services/wallet_service').WalletService;
    });

    afterAll(async () => { if (ds?.isInitialized) await ds.destroy(); });

    beforeEach(async () => {
        for (const t of ['ledger_entry', 'payout_record', 'transaction', 'wallet', 'audit_log', 'ride']) {
            await ds.query(`TRUNCATE TABLE ride_void_test."${t}" CASCADE`);
        }
    });

    async function driver(available = 0, debt = 0): Promise<string> {
        const id = uuid();
        await ds.getRepository(Wallet).save(ds.getRepository(Wallet).create({
            userId: id, driverAvailableBalance: available, driverCommissionDebt: debt,
        } as any));
        return id;
    }

    /** A completed cash ride, as the training sessions produced. */
    async function completedRide(driverId: string, over: Partial<Ride> = {}): Promise<string> {
        const rideId = uuid();
        await ds.getRepository(Ride).save(ds.getRepository(Ride).create({
            rideId, passengerId: uuid(), driverId, status: 'completed',
            fare: FARE, finalFare: FARE, paymentMode: 'cash',
            pickupAddress: 'Training pickup', destinationAddress: 'Training drop',
            ...over,
        } as any));
        return rideId;
    }

    const wallet = async (id: string) => {
        const w = await ds.getRepository(Wallet).findOneBy({ userId: id });
        return { available: Number(w!.driverAvailableBalance), debt: Number(w!.driverCommissionDebt) };
    };
    // Matches the jsonb key. `find({ where: { metadata: { rideId } } })`
    // compares the whole JSON document and quietly matches nothing, which
    // makes "expect no entries" pass for the wrong reason.
    const entriesFor = (rideId: string): Promise<LedgerEntry[]> =>
        ds.getRepository(LedgerEntry)
            .createQueryBuilder('le')
            .where(`le.metadata->>'rideId' = :rideId`, { rideId })
            .getMany();

    /** What the admin VOID endpoint does, minus Express. */
    async function voidRide(rideId: string, reason = 'Field-training ride') {
        const reversal = await WalletService.reverseRideFinancials(rideId, reason);
        await ds.getRepository(Ride).update(rideId, {
            paymentHeld: false, voided: true, voidedAt: new Date(),
            voidedReason: reason, voidedBy: 'test-admin',
        } as any);
        await ds.getRepository(AuditLog).save(ds.getRepository(AuditLog).create({
            adminId: 'test-admin', action: 'VOIDED_HELD_RIDE_PAYMENT',
            entityType: 'RIDE', entityId: rideId, details: { reason, reversal },
        } as any));
        return reversal;
    }

    // ── 1–4. no earnings, no commission, no debt, no withdrawable ──────

    it('a voided ride pays no earnings, charges no commission and creates no debt', async () => {
        const d = await driver(0, 0);
        const rideId = await completedRide(d);

        await voidRide(rideId);

        expect(await wallet(d)).toEqual({ available: 0, debt: 0 });
        expect(await entriesFor(rideId)).toHaveLength(0);
    });

    it('a voided ride does not increase withdrawable balance', async () => {
        const d = await driver(500, 0);
        const before = await WalletService.withdrawableFrom(d);
        await voidRide(await completedRide(d));
        expect(await WalletService.withdrawableFrom(d)).toBe(before);
    });

    // ── 5. automatic financial recovery must skip it ───────────────────

    it('the automatic recovery worker does not select a voided ride', async () => {
        const d = await driver(0, 0);
        // paymentFailed is set here on purpose: this is exactly the shape the
        // old void left behind, and the shape the worker hunts for.
        // Due for retry right now, so the only thing keeping it out of the
        // worker's batch is the voided flag.
        const rideId = await completedRide(d, {
            paymentFailed: true, financialNextRetryAt: new Date(Date.now() - 60_000),
        } as any);
        const { FinancialRecoveryWorker } = require('../../src/services/financial_recovery_worker');

        // Before the void it *is* selected — proving the test is not vacuous.
        expect((await FinancialRecoveryWorker.findDue(100)).map((r: any) => r.rideId)).toContain(rideId);

        await voidRide(rideId);

        expect((await FinancialRecoveryWorker.findDue(100)).map((r: any) => r.rideId)).not.toContain(rideId);
    });

    // ── 6. a manual retry must refuse it ───────────────────────────────

    it('a manual retry refuses to post a voided ride', async () => {
        const d = await driver(0, 0);
        const rideId = await completedRide(d, { paymentFailed: true } as any);
        await voidRide(rideId);

        const result = await WalletService.retryFailedPosting(rideId, { staffUserId: 'test', label: 'test' });

        expect(result.ok).toBe(false);
        expect(result.code).toBe('VOIDED');
        expect(await wallet(d)).toEqual({ available: 0, debt: 0 });
        expect(await entriesFor(rideId)).toHaveLength(0);
    });

    it('a voided ride is not listed as a financial exception', async () => {
        const d = await driver(0, 0);
        const rideId = await completedRide(d, { paymentFailed: true } as any);
        await voidRide(rideId);

        const exceptions = await WalletService.financialExceptions(100);
        expect(exceptions.map((r: any) => r.rideId)).not.toContain(rideId);
    });

    // ── 7. identifiable in the audit trail ─────────────────────────────

    it('a voided ride is identifiable as voided on the ride and in the audit log', async () => {
        const d = await driver(0, 0);
        const rideId = await completedRide(d);
        await voidRide(rideId, 'Driver training — Ikeja park');

        const ride = await ds.getRepository(Ride).findOneBy({ rideId });
        expect(ride!.voided).toBe(true);
        expect(ride!.voidedReason).toBe('Driver training — Ikeja park');
        expect(ride!.voidedBy).toBe('test-admin');
        expect(ride!.voidedAt).toBeInstanceOf(Date);

        const audit = await ds.getRepository(AuditLog).findOne({
            where: { entityId: rideId, action: 'VOIDED_HELD_RIDE_PAYMENT' },
        });
        expect(audit).not.toBeNull();
    });

    // ── reversal: money already posted before the void ─────────────────

    it('reverses commission already charged, without deleting the original entries', async () => {
        const d = await driver(5000, 0);
        const rideId = await completedRide(d);

        await WalletService.postRideFinancials({
            rideId, passengerId: uuid(), driverId: d, totalFare: FARE, isCash: true,
        });
        expect(await wallet(d)).toEqual({ available: 5000 - COMMISSION, debt: 0 });
        const postedCount = (await entriesFor(rideId)).length;

        const reversal = await voidRide(rideId);

        expect(reversal.reversed).toBe(true);
        expect(await wallet(d)).toEqual({ available: 5000, debt: 0 });

        const after = await entriesFor(rideId);
        expect(after.length).toBeGreaterThan(postedCount);   // appended, not edited
        expect(after.filter((e) => (e.metadata as any)?.reversalOf === rideId).length).toBeGreaterThan(0);
    });

    it('reverses commission that had gone into debt', async () => {
        const d = await driver(0, 0);                        // nothing to pay with
        const rideId = await completedRide(d);

        await WalletService.postRideFinancials({
            rideId, passengerId: uuid(), driverId: d, totalFare: FARE, isCash: true,
        });
        expect((await wallet(d)).debt).toBe(COMMISSION);

        await voidRide(rideId);

        expect(await wallet(d)).toEqual({ available: 0, debt: 0 });
    });

    it('voiding twice does not reverse twice', async () => {
        const d = await driver(5000, 0);
        const rideId = await completedRide(d);
        await WalletService.postRideFinancials({
            rideId, passengerId: uuid(), driverId: d, totalFare: FARE, isCash: true,
        });

        await voidRide(rideId);
        const second = await WalletService.reverseRideFinancials(rideId, 'again');

        expect(second.reversed).toBe(false);
        expect(await wallet(d)).toEqual({ available: 5000, debt: 0 });
    });

    it('the automatic worker leaves a ride that is held for review alone', async () => {
        const d = await driver(5000, 0);
        const rideId = await completedRide(d, {
            paymentFailed: true, paymentHeld: true,
            financialNextRetryAt: new Date(Date.now() - 60_000),
        } as any);

        const { FinancialRecoveryWorker } = require('../../src/services/financial_recovery_worker');
        const due = await FinancialRecoveryWorker.findDue(100);

        expect(due.map((r: any) => r.rideId)).not.toContain(rideId);
        expect(await wallet(d)).toEqual({ available: 5000, debt: 0 });
    });

    it('a genuine unvoided failure is still recovered — the guard is not a blanket off-switch', async () => {
        const d = await driver(5000, 0);
        const rideId = await completedRide(d, { paymentFailed: true } as any);

        const result = await WalletService.retryFailedPosting(rideId, { staffUserId: 'test', label: 'test' });

        expect(result.ok).toBe(true);
        expect(await wallet(d)).toEqual({ available: 5000 - COMMISSION, debt: 0 });
    });
});
