/**
 * The one way a service zone is turned on, turned off, or inspected.
 *
 * DRY-RUN BY DEFAULT. Nothing changes unless `--apply` is passed.
 *
 *   npm run zone:status                                  what is live, right now
 *   npm run zone:probe -- --lat=6.2109 --lng=7.0740      classify one coordinate
 *   npm run zone:activate -- --code=AWK                  show the plan
 *   npm run zone:activate -- --code=AWK --apply          do it
 *   npm run zone:rollback -- --code=AWK --apply          take it dark again
 *
 * (On the droplet the `:prod` variants run the compiled build inside the
 * container — see the field launch runbook.)
 *
 * ── Why this exists rather than a SQL statement ─────────────────────────
 * `UPDATE service_zone SET status='active'` reaches the same row and skips
 * everything that makes the change safe:
 *
 *   1. VALIDATION.    ServiceZoneService.setMode refuses `enforce` on a zone
 *                     that is not `active`. SQL will happily write
 *                     draft+enforce, which is representable and means nothing.
 *   2. CACHE.         Zones are cached in-process for 60s. setMode busts the
 *                     cache on the writing process; SQL leaves every process
 *                     serving stale zones until the TTL happens to expire.
 *   3. AUDIT.         setMode emits `zone_mode_changed` with the before and
 *                     after. A SQL update leaves no record of who changed what.
 *
 * So this is not a wrapper around SQL for tidiness. It is the administrative
 * mechanism, and the SQL is the unsafe shortcut around it.
 *
 * ── What it deliberately cannot do ──────────────────────────────────────
 * Edit geometry. Redrawing a boundary and opening a city are different
 * decisions with different blast radii, and a single "update zone" command
 * invites doing both in one unreviewed action. Boundaries change by migration.
 */
import 'reflect-metadata';
import dotenv from 'dotenv';
import { AppDataSource } from '../config/data_source';
import { ServiceZoneService } from '../services/service_zone_service';
import { ServiceZoneResolver } from '../services/service_zone_resolver';
import { ServiceZonePolicy } from '../services/service_zone_policy';
import { ServiceZoneStatus, ZoneEnforcement } from '../models/ServiceZone';
import { ServiceZoneConfig } from '../config/service_zone_config';

dotenv.config();

const args = process.argv.slice(2);
const command = (args.find((a) => !a.startsWith('--')) ?? 'status').toLowerCase();
const apply = args.includes('--apply');
const asJson = args.includes('--json');
const argOf = (name: string): string | undefined =>
    args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];

const code = (argOf('code') ?? '').toUpperCase();

function line(k: string, v: unknown): void {
    console.log(`  ${k.padEnd(22)} ${v}`);
}

/** Everything an operator needs before deciding anything. */
async function status(): Promise<void> {
    const zones = await ServiceZoneService.list();
    const operational = await ServiceZoneService.operationalZones();
    const enforcing = await ServiceZoneService.enforcingZoneCount();
    const posture = await ServiceZonePolicy.globalPosture();

    if (asJson) {
        console.log(JSON.stringify({
            killSwitchEnabled: ServiceZoneConfig.enabled,
            cacheTtlMs: ServiceZoneConfig.cacheTtlMs,
            enforcingZoneCount: enforcing,
            globalPosture: posture,
            failClosed: await ServiceZoneService.shouldFailClosed(),
            zones: zones.map((z) => ({
                code: z.code, name: z.name, status: z.status, enforcement: z.enforcement,
                bufferMeters: z.bufferMeters, priority: z.priority,
                operational: operational.some((o) => o.code === z.code),
                updatedAt: z.updatedAt,
            })),
        }, null, 2));
        return;
    }

    console.log('\nSERVICE ZONES\n');
    console.log('  code  name        status    enforcement  dispatch sees it');
    console.log('  ────  ──────────  ────────  ───────────  ────────────────');
    for (const z of zones) {
        const seen = operational.some((o) => o.code === z.code) ? 'YES' : 'no';
        console.log(`  ${z.code.padEnd(5)} ${(z.name ?? '').padEnd(11)} `
            + `${String(z.status).padEnd(9)} ${String(z.enforcement).padEnd(12)} ${seen}`);
    }
    console.log('');
    line('enforcing zones', enforcing);
    line('global posture', posture);
    // Two or more enforcing zones changes what a resolver fault does, so it is
    // never a detail to discover afterwards.
    line('fail closed on error', await ServiceZoneService.shouldFailClosed());
    line('kill switch enabled', ServiceZoneConfig.enabled
        ? 'yes (normal)' : 'NO — zones are globally disabled');
    line('cache TTL', `${ServiceZoneConfig.cacheTtlMs} ms`);
    console.log('');
}

/**
 * What would happen to a ride requested from this coordinate, right now.
 *
 * The safe way to check an out-of-coverage case without travelling to it:
 * read-only, creates nothing, and reports exactly what the dispatch path
 * would conclude.
 */
async function probe(): Promise<void> {
    const lat = Number(argOf('lat'));
    const lng = Number(argOf('lng'));
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        throw new Error('usage: zone:probe -- --lat=<n> --lng=<n>');
    }

    const r = await ServiceZoneResolver.resolve({ lat, lng });
    const zoneCode = r.kind === 'inside' ? r.zoneCode : null;
    const matchKind = r.kind === 'inside' ? r.match : (r.kind === 'outside' ? 'none' : null);
    const policy = await ServiceZonePolicy.forRide(zoneCode, matchKind);

    if (asJson) {
        console.log(JSON.stringify({ lat, lng, resolution: r, policy,
            refusalReason: ServiceZonePolicy.refusalReason(policy) }, null, 2));
        return;
    }

    console.log(`\nPICKUP  ${lat}, ${lng}\n`);
    line('resolves to', r.kind === 'inside'
        ? `${r.zoneCode} (${r.match})`
        : r.kind === 'outside'
            ? `OUTSIDE — nearest ${r.nearestZoneCode ?? '—'}, ${Math.round(r.distanceM)} m away`
            : `ERROR — ${r.reason}`);
    line('ride zoneCode', zoneCode ?? 'null');
    line('zoneMatchKind', matchKind ?? 'null');
    line('coverage', policy.coverage);
    line('mode', policy.mode);
    line('would refuse?', policy.constrain ? 'YES — enforcement is on' : 'no');
    const why = ServiceZonePolicy.refusalReason(policy);
    // Under observe this is the sentence enforcement WOULD have used. Same
    // computation, so what is measured now is what would be applied later.
    if (why) line(policy.constrain ? 'refusal reason' : 'would say', why);
    console.log('');
}

/**
 * Open a city: `draft` → `active`.
 *
 * Enforcement is deliberately NOT touched. Activation and enforcement are two
 * decisions, and coupling them here would make "open Awka" silently mean "start
 * refusing people", which is the one thing this whole design exists to keep
 * apart.
 */
async function activate(): Promise<void> {
    const zones = await ServiceZoneService.list();
    const zone = zones.find((z) => z.code === code);
    if (!zone) throw new Error(`no zone with code "${code}"`);

    console.log(`\nACTIVATE ${zone.code} — ${zone.name}\n`);
    line('status', `${zone.status}  →  active`);
    line('enforcement', `${zone.enforcement}  (unchanged — see below)`);
    console.log('');
    console.log('  Activation opens the city to dispatch. It does NOT enable geographic');
    console.log('  enforcement: nothing is refused until enforcement is changed');
    console.log('  separately, and deliberately.');

    if (!apply) {
        console.log('\n  DRY RUN — nothing changed. Re-run with --apply.\n');
        return;
    }

    const saved = await ServiceZoneService.setMode(zone.code, {
        status: ServiceZoneStatus.ACTIVE,
    });
    console.log('\n  APPLIED\n');
    line('status', saved!.status);
    line('enforcement', saved!.enforcement);
    line('enforcing zones', await ServiceZoneService.enforcingZoneCount());
    console.log('\n  Other processes pick this up within the cache TTL '
        + `(${ServiceZoneConfig.cacheTtlMs} ms).\n`);
}

/**
 * Take a city back out of service: → `draft`, `off`.
 *
 * The launch-day kill switch for ONE city. It touches a single row and cannot
 * reach another zone: no ride is modified, no driver is modified, no wallet is
 * modified, and a ride already in flight keeps the zone it was born with.
 */
async function rollback(): Promise<void> {
    const zones = await ServiceZoneService.list();
    const zone = zones.find((z) => z.code === code);
    if (!zone) throw new Error(`no zone with code "${code}"`);

    console.log(`\nROLL BACK ${zone.code} — ${zone.name}\n`);
    line('status', `${zone.status}  →  draft`);
    line('enforcement', `${zone.enforcement}  →  off`);
    console.log('');
    console.log('  New requests from this area stop being dispatched within the cache');
    console.log('  TTL. Rides already in flight are untouched and complete normally —');
    console.log('  a ride carries the zone it was born with for its whole life.');
    console.log('  No other zone is read or written.');

    if (!apply) {
        console.log('\n  DRY RUN — nothing changed. Re-run with --apply.\n');
        return;
    }

    const saved = await ServiceZoneService.setMode(zone.code, {
        status: ServiceZoneStatus.DRAFT,
        enforcement: ZoneEnforcement.OFF,
    });
    console.log('\n  APPLIED\n');
    line('status', saved!.status);
    line('enforcement', saved!.enforcement);
    console.log('');
    await status();
}

/**
 * Change enforcement, on its own.
 *
 * Separate command from activation, on purpose. Turning a city on and starting
 * to refuse people outside it are not the same decision and must not share a
 * keystroke.
 */
async function setEnforcement(): Promise<void> {
    const raw = (argOf('mode') ?? '').toLowerCase();
    const mode = Object.values(ZoneEnforcement).find((m) => m === raw);
    if (!mode) {
        throw new Error(`usage: zone:enforcement -- --code=<CODE> --mode=<${Object.values(ZoneEnforcement).join('|')}>`);
    }
    const zone = (await ServiceZoneService.list()).find((z) => z.code === code);
    if (!zone) throw new Error(`no zone with code "${code}"`);

    console.log(`\nENFORCEMENT ${zone.code} — ${zone.name}\n`);
    line('enforcement', `${zone.enforcement}  →  ${mode}`);
    if (mode === ZoneEnforcement.ENFORCE) {
        console.log('');
        console.log('  ENFORCE refuses ride requests whose pickup is outside every active');
        console.log('  zone. Passengers on an app build older than 1.5.1 will see a generic');
        console.log('  "something went wrong" message instead of the real reason.');
    }

    if (!apply) {
        console.log('\n  DRY RUN — nothing changed. Re-run with --apply.\n');
        return;
    }
    const saved = await ServiceZoneService.setMode(zone.code, { enforcement: mode });
    console.log('\n  APPLIED\n');
    line('enforcement', saved!.enforcement);
    line('enforcing zones', await ServiceZoneService.enforcingZoneCount());
    console.log('');
}

async function main(): Promise<void> {
    await AppDataSource.initialize();
    try {
        switch (command) {
            case 'status':      await status(); break;
            case 'probe':       await probe(); break;
            case 'activate':    await activate(); break;
            case 'rollback':    await rollback(); break;
            case 'enforcement': await setEnforcement(); break;
            default:
                throw new Error(`unknown command "${command}" — `
                    + 'expected status | probe | activate | rollback | enforcement');
        }
    } finally {
        await AppDataSource.destroy();
    }
}

main()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error(`\n  ${err?.message ?? err}\n`);
        process.exit(1);
    });
