/**
 * Wallet reconciliation. READ-ONLY — it never modifies a financial record.
 *
 * Checks stored wallet state against the ledger that should have produced it,
 * and looks for the specific ways money accounting goes wrong.
 *
 * ── One subtlety that matters ────────────────────────────────────────────
 * Not every ledger row is a balance movement. `cash_received` records physical
 * cash a driver collected — it never enters the platform balance — and
 * `commission_credit` records platform revenue. Both are written with
 * balanceBefore == balanceAfter. Summing `amount` naively over-counts them by
 * the full fare and reports enormous phantom drift (₦98,705 across 18 wallets,
 * on first run). The ledger's own claim about final state is the LAST entry's
 * balanceAfter per (wallet, balanceType), so that is what is compared.
 *
 *   npm run wallet:reconcile:prod
 */
import 'reflect-metadata';
import { AppDataSource } from '../config/data_source';

const money = (n: number) => `₦${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2 })}`;

async function main(): Promise<void> {
    await AppDataSource.initialize();
    const q = (sql: string) => AppDataSource.query(sql);
    let problems = 0;
    const section = (t: string) => console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 58 - t.length))}`);

    console.log('\n═══ KekeRide wallet reconciliation ═══');

    section('Stored balance vs ledger');
    const drift = await q(`
        WITH last_entry AS (
            SELECT DISTINCT ON ("walletId","balanceType") "walletId","balanceType","balanceAfter"
            FROM ledger_entry ORDER BY "walletId","balanceType","createdAt" DESC, id DESC)
        SELECT w."userId",
               w."driverAvailableBalance" AS stored_avail, COALESCE(la."balanceAfter",0) AS ledger_avail,
               w."driverCommissionDebt"   AS stored_debt,  COALESCE(ld."balanceAfter",0) AS ledger_debt
        FROM wallet w
        LEFT JOIN last_entry la ON la."walletId"=w."userId" AND la."balanceType"='driver_available'
        LEFT JOIN last_entry ld ON ld."walletId"=w."userId" AND ld."balanceType"='driver_commission_debt'
        WHERE ROUND(w."driverAvailableBalance",2) <> ROUND(COALESCE(la."balanceAfter",0),2)
           OR ROUND(w."driverCommissionDebt",2)   <> ROUND(COALESCE(ld."balanceAfter",0),2)`);
    if (drift.length === 0) console.log('  ✓ every wallet matches its ledger');
    else {
        problems += drift.length;
        for (const d of drift) {
            console.log(`  ✗ ${d.userId}  avail stored ${money(d.stored_avail)} vs ledger ${money(d.ledger_avail)}` +
                `  |  debt stored ${money(d.stored_debt)} vs ledger ${money(d.ledger_debt)}`);
        }
    }

    section('Business rule: balance held while in debt');
    const both = await q(`SELECT "userId","driverAvailableBalance" a,"driverCommissionDebt" d
                          FROM wallet WHERE "driverCommissionDebt">0 AND "driverAvailableBalance">0`);
    if (both.length === 0) console.log('  ✓ no driver holds withdrawable money while owing');
    else {
        problems += both.length;
        console.log(`  ✗ ${both.length} wallet(s) hold a balance while in debt:`);
        for (const w of both) console.log(`      ${w.userId}  available ${money(w.a)}  debt ${money(w.d)}`);
    }

    section('Duplicate money');
    const dupTopup = await q(`SELECT metadata->>'reference' r, COUNT(*) c FROM ledger_entry
        WHERE "transactionType"='topup' AND metadata->>'reference' IS NOT NULL
        GROUP BY 1 HAVING COUNT(*)>1`);
    /*
     * A single commission can legitimately produce TWO commission_charge rows:
     * one debiting driver_available for what the balance could cover, and one
     * adding the shortfall to driver_commission_debt. They are two legs of one
     * charge, not two charges.
     *
     * Counting rows per ride reported RIDE-1783964367780 as double-charged
     * when it was correctly split ₦111.07 from balance + ₦74.02 to debt. A
     * reconciliation tool that cries wolf is worse than none, so this counts
     * charges per (ride, balanceType).
     */
    const dupComm = await q(`SELECT metadata->>'rideId' r, "balanceType" bt, COUNT(*) c
        FROM ledger_entry
        WHERE "transactionType"='commission_charge' AND metadata->>'rideId' IS NOT NULL
        GROUP BY 1,2 HAVING COUNT(*)>1`);
    console.log(dupTopup.length ? `  ✗ ${dupTopup.length} reference(s) credited more than once` : '  ✓ no duplicate funding');
    if (dupComm.length) { problems += dupComm.length;
        console.log(`  ✗ ${dupComm.length} ride(s) charged commission more than once:`);
        for (const d of dupComm) console.log(`      ride ${d.r} (${d.bt}) × ${d.c}`);
    } else console.log('  ✓ no duplicate commission');
    problems += dupTopup.length;

    section('Rides vs commission');
    const [missing] = await q(`SELECT COUNT(*) c, COALESCE(ROUND(SUM(COALESCE("finalFare",fare) - COALESCE("finalFare",fare)/1.1),2),0) v
        FROM ride r WHERE r.status='completed' AND r."paymentMode"='cash'
          AND COALESCE(r."paymentHeld",false)=false
          AND NOT EXISTS (SELECT 1 FROM ledger_entry le WHERE le.metadata->>'rideId'=r."rideId")`);
    if (Number(missing.c) === 0) console.log('  ✓ every completed cash ride has a financial record');
    else {
        problems += Number(missing.c);
        console.log(`  ✗ ${missing.c} completed cash ride(s) with NO ledger entry — ${money(missing.v)} commission unposted`);
        const [flagged] = await q(`SELECT COUNT(*) c FROM ride r WHERE r.status='completed'
            AND r."paymentMode"='cash' AND COALESCE(r."paymentFailed",false)=true
            AND NOT EXISTS (SELECT 1 FROM ledger_entry le WHERE le.metadata->>'rideId'=r."rideId")`);
        console.log(`      of which ${flagged.c} are already flagged paymentFailed — the system knew`);
    }

    const [orphan] = await q(`SELECT COUNT(*) c FROM ledger_entry le
        WHERE le."transactionType"='commission_charge' AND le.metadata->>'rideId' IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM ride r WHERE r."rideId"=le.metadata->>'rideId' AND r.status='completed')`);
    console.log(Number(orphan.c) === 0 ? '  ✓ no commission without a completed ride'
        : `  ✗ ${orphan.c} commission entr(ies) with no matching completed ride`);
    problems += Number(orphan.c);

    const [wrongStatus] = await q(`SELECT COUNT(*) c FROM ledger_entry le
        JOIN ride r ON r."rideId"=le.metadata->>'rideId'
        WHERE le."transactionType"='commission_charge' AND r.status IN ('canceled','failed')`);
    console.log(Number(wrongStatus.c) === 0 ? '  ✓ no commission on cancelled or failed rides'
        : `  ✗ ${wrongStatus.c} commission entr(ies) on cancelled/failed rides`);
    problems += Number(wrongStatus.c);

    section('Payments');
    const [uncredited] = await q(`SELECT COUNT(*) c FROM transaction t WHERE t.status='success'
        AND NOT EXISTS (SELECT 1 FROM ledger_entry le WHERE le.metadata->>'reference'=t.reference)`);
    const [unverified] = await q(`SELECT COUNT(*) c FROM ledger_entry le
        WHERE le."transactionType"='topup' AND le.metadata->>'reference' IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM transaction t WHERE t.reference=le.metadata->>'reference' AND t.status='success')`);
    console.log(Number(uncredited.c) === 0 ? '  ✓ every successful payment reached a wallet'
        : `  ✗ ${uncredited.c} payment(s) verified but never credited`);
    console.log(Number(unverified.c) === 0 ? '  ✓ every credit has a verified payment'
        : `  ✗ ${unverified.c} credit(s) with no verified payment`);
    problems += Number(uncredited.c) + Number(unverified.c);

    section('Negative balances');
    const [neg] = await q(`SELECT COUNT(*) c FROM wallet
        WHERE "driverAvailableBalance"<0 OR "driverCommissionDebt"<0 OR "driverPendingBalance"<0`);
    console.log(Number(neg.c) === 0 ? '  ✓ no negative balances' : `  ✗ ${neg.c} wallet(s) negative`);
    problems += Number(neg.c);

    console.log(`\n═══ ${problems === 0 ? 'CLEAN' : `${problems} finding(s)`} ═══`);
    console.log('This script does not modify financial records. Act on findings deliberately.\n');
    await AppDataSource.destroy();
}

main().catch(async (e) => {
    console.error(e?.message || e);
    try { await AppDataSource.destroy(); } catch { /* already closed */ }
    process.exit(1);
});
