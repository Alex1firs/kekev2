/**
 * Maintenance command for stale rides — including the historical backlog.
 *
 * DRY-RUN BY DEFAULT. Nothing is mutated unless `--apply` is passed explicitly.
 *
 *   npm run rides:sweep                 # report only, safe any time
 *   npm run rides:sweep -- --apply      # perform the actions
 *   npm run rides:sweep -- --json       # machine-readable report
 *
 * Runs the SAME policy and the SAME cleanup service as the scheduled sweeper, so
 * a one-off backlog clear cannot diverge from ongoing behaviour. No production
 * ride ids appear anywhere in this file: candidates are always selected by the
 * approved criteria, never by hand.
 */
import 'reflect-metadata';
import dotenv from 'dotenv';
import { AppDataSource } from '../config/data_source';
import { loadStaleRideConfig } from '../config/stale_ride_config';
import { StaleRideSweeper, SweepPlanItem } from '../services/stale_ride_sweeper';

dotenv.config();

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const asJson = args.includes('--json');
/** Raise the batch ceiling for a backlog clear. */
const limitArg = args.find((a) => a.startsWith('--limit='));
const limit = limitArg ? Number(limitArg.split('=')[1]) : undefined;

function minutes(v: number | null): string {
    return v == null ? '—' : `${v.toFixed(1)}m`;
}

function iso(d: Date | null): string {
    return d ? d.toISOString().replace('T', ' ').slice(0, 19) : '—';
}

function ageOf(ms: number | null): string {
    if (ms == null) return 'no heartbeat';
    if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
    return `${Math.round(ms / 60_000)}m`;
}

/** One row per candidate, with every field an operator needs to sanity-check it. */
function printPlan(plan: SweepPlanItem[]): void {
    const actionable = plan.filter((p) => p.action !== 'none');
    if (actionable.length === 0) {
        console.log('\nNo actionable stale rides found.\n');
        return;
    }

    console.log(`\n${actionable.length} actionable ride(s):\n`);
    for (const p of actionable) {
        console.log(`  ride            ${p.rideId}`);
        console.log(`  status          ${p.status}`);
        console.log(`  passenger       ${p.passengerId ?? '—'}`);
        console.log(`  driver          ${p.driverId ?? '—'}`);
        console.log(`  acceptedAt      ${iso(p.acceptedAt)}`);
        console.log(`  arrivedAt       ${iso(p.arrivedAt)}`);
        console.log(`  startedAt       ${iso(p.startedAt)}`);
        console.log(`  age             ${minutes(p.ageMinutes)}`);
        console.log(`  pickup ETA      ${minutes(p.estimatedPickupEtaMinutes)}`);
        console.log(`  deadline        ${minutes(p.deadlineMinutes)} -> ${iso(p.deadlineAt)}`);
        console.log(`  driver HB age   ${ageOf(p.driverHeartbeatAgeMs)}${p.driverHeartbeatFresh ? ' (fresh)' : ' (stale)'}`);
        console.log(`  ACTION          ${p.action.toUpperCase()}`);
        console.log(`  reason          ${p.reason ?? '—'}`);
        console.log(`  why             ${p.explanation}`);
        console.log('');
    }
}

async function main(): Promise<void> {
    const config = { ...loadStaleRideConfig() };
    if (limit != null && Number.isFinite(limit) && limit > 0) {
        config.batchSize = Math.floor(limit);
    }
    // The scheduled sweeper's own dry-run setting must not decide what an
    // operator explicitly asked for on the command line.
    const dryRun = !apply;

    await AppDataSource.initialize();
    try {
        if (!asJson) {
            console.log('');
            console.log('  Keke stale-ride maintenance sweep');
            console.log('  ---------------------------------');
            console.log(`  mode              ${dryRun ? 'DRY RUN (no changes)' : 'APPLY (will mutate)'}`);
            console.log(`  batch size        ${config.batchSize}`);
            console.log(`  accepted window   min ${config.acceptedMinMinutes}m, ETA x${config.acceptedEtaMultiplier}, max ${config.acceptedMaxMinutes}m`);
            console.log(`  arrived window    warn ${config.arrivedWarnMinutes}m, cancel ${config.arrivedCancelMinutes}m`);
            console.log(`  in-progress       review at max(est x${config.inProgressDurationMultiplier}, ${config.inProgressMinMinutes}m), cap ${config.inProgressAbsoluteMinutes}m`);
            console.log('  in-progress trips are FLAGGED for review, never auto-cancelled.');
            console.log('');
        }

        const report = await StaleRideSweeper.runOnce(config, { dryRun });

        if (asJson) {
            console.log(JSON.stringify(report, null, 2));
        } else {
            printPlan(report.plan);
            console.log('  Summary');
            console.log(`    examined        ${report.examined}`);
            console.log(`    would warn      ${report.warned}`);
            console.log(`    would cancel    ${report.cancelled}`);
            console.log(`    would flag      ${report.flagged}`);
            console.log(`    skipped         ${report.skipped}`);
            console.log(`    lost races      ${report.lostRaces}`);
            console.log(`    errors          ${report.errors}`);
            console.log('');
            if (dryRun && (report.warned || report.cancelled || report.flagged)) {
                console.log('  Nothing was changed. Re-run with --apply to perform these actions.');
                console.log('');
            }
        }

        // Non-zero exit on error so a cron wrapper can alert.
        if (report.errors > 0) process.exitCode = 1;
    } finally {
        await AppDataSource.destroy();
    }
}

main().catch((err) => {
    console.error('[rides:sweep] failed:', err?.message ?? err);
    process.exit(1);
});
