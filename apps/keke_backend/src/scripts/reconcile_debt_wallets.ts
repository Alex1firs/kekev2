/**
 * One-off reconciliation: apply existing balance against existing debt for
 * drivers who hold both.
 *
 * ── Why these wallets exist ──────────────────────────────────────────────
 * Before the debt-first settlement fix, funding a driver credited their
 * balance and left the debt standing. These are the wallets that ended up in
 * that state. The fix settles on the NEXT credit; it does not reach back.
 *
 * ── What this does and does not do ───────────────────────────────────────
 * It moves money that is already the driver's balance against debt they
 * already owe. It creates NO new money, deletes nothing, and rewrites no
 * historical entry — the original top-up and commission rows stay exactly as
 * they are, and this appends a settlement on top with its own source so an
 * auditor can see it was an operations action rather than the driver paying.
 *
 * Dry-run by default. Pass --apply to commit.
 *
 *   npm run wallet:reconcile-debt:prod            # report only
 *   npm run wallet:reconcile-debt:prod -- --apply # commit
 */
import 'reflect-metadata';
import { AppDataSource } from '../config/data_source';
import { Wallet } from '../models/Wallet';
import { LedgerEntry } from '../models/LedgerEntry';
import { WalletService } from '../services/wallet_service';

const APPLY = process.argv.includes('--apply');
const SOURCE = 'operations_reconciliation_2026_08';
const money = (n: number) => `₦${Number(n).toFixed(2)}`;

async function main(): Promise<void> {
    await AppDataSource.initialize();

    const targets = await AppDataSource.getRepository(Wallet)
        .createQueryBuilder('w')
        .where('w."driverCommissionDebt" > 0 AND w."driverAvailableBalance" > 0')
        .orderBy('w."userId"')
        .getMany();

    console.log(`\n═══ Debt reconciliation ${APPLY ? '(APPLYING)' : '(DRY RUN — nothing will change)'} ═══`);
    console.log(`Wallets holding a balance while in debt: ${targets.length}\n`);

    if (targets.length === 0) { await AppDataSource.destroy(); return; }

    for (const w of targets) {
        const availableBefore = Number(w.driverAvailableBalance);
        const debtBefore = Number(w.driverCommissionDebt);
        const willApply = Math.min(availableBefore, debtBefore);

        console.log(`  driver ${w.userId}`);
        console.log(`    balance before   ${money(availableBefore)}`);
        console.log(`    debt before      ${money(debtBefore)}`);
        console.log(`    to apply         ${money(willApply)}`);

        if (!APPLY) {
            console.log(`    balance after    ${money(availableBefore - willApply)}  (projected)`);
            console.log(`    debt after       ${money(debtBefore - willApply)}  (projected)\n`);
            continue;
        }

        const result = await WalletService.repayDebtFromBalance(w.userId, SOURCE, {
            reconciliation: true,
            reason: 'pre-fix funding did not settle debt',
            availableBefore,
            debtBefore,
        });

        const after = await AppDataSource.getRepository(Wallet).findOneBy({ userId: w.userId });
        const entries = await AppDataSource.getRepository(LedgerEntry).find({
            where: { walletId: w.userId },
            order: { createdAt: 'DESC' },
            take: 2,
        });

        console.log(`    applied          ${money(result.applied)}`);
        console.log(`    balance after    ${money(Number(after!.driverAvailableBalance))}`);
        console.log(`    debt after       ${money(Number(after!.driverCommissionDebt))}`);
        console.log(`    withdrawable     ${money(WalletService.withdrawableFrom(after!))}`);
        console.log(`    ledger entries   ${entries.length} created:`);
        for (const e of entries) {
            console.log(`        ${new Date(e.createdAt).toISOString()}  ${e.balanceType}` +
                `  ${money(Number(e.amount))}  ${money(Number(e.balanceBefore))} → ${money(Number(e.balanceAfter))}` +
                `  source=${(e.metadata as any)?.source}`);
        }
        console.log('');
    }

    if (!APPLY) console.log('Nothing was changed. Re-run with --apply to commit.\n');
    else console.log('Reconciliation committed.\n');

    await AppDataSource.destroy();
}

main().catch(async (e) => {
    console.error(e?.message || e);
    try { await AppDataSource.destroy(); } catch { /* already closed */ }
    process.exit(1);
});
