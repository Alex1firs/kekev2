/**
 * The whole story of one driver's reachability, and of one ride's dispatch.
 *
 * Built for the presence field test: after an unattended handset is sent a
 * ride, this answers — from the server's own records, not from inference —
 * what the driver's intent was, whether their phone was quiet, whether we
 * knocked, whether they answered, on what position, whether they entered the
 * live geo query, and what happened to the offer.
 *
 *   npx ts-node src/scripts/presence_trace.ts <driverIdOrEmailOrPhone> [minutes]
 *
 * Read-only. Writes nothing, sends nothing, wakes nobody.
 */
import 'reflect-metadata';
import { AppDataSource } from '../config/data_source';
import { DriverPresenceIntent } from '../models/DriverPresenceIntent';
import { DispatchService } from '../services/dispatch_service';
import { redis } from '../config/redis';

const ARG = process.argv[2];
const WINDOW_MIN = Number(process.argv[3] || 180);

function line(label: string, value: unknown) {
    console.log(`  ${String(label).padEnd(26)} ${value === null || value === undefined ? '—' : value}`);
}
function head(t: string) { console.log(`\n${'─'.repeat(74)}\n ${t}\n${'─'.repeat(74)}`); }
const ago = (d: Date | string | null | undefined) => {
    if (!d) return '—';
    const ms = Date.now() - new Date(d).getTime();
    const s = Math.round(ms / 1000);
    if (s < 90) return `${s}s ago`;
    if (s < 5400) return `${Math.round(s / 60)}m ago`;
    return `${(s / 3600).toFixed(1)}h ago`;
};

(async () => {
    if (!ARG) { console.error('usage: presence_trace <driverIdOrEmailOrPhone> [minutes]'); process.exit(1); }
    await AppDataSource.initialize();

    // ── Resolve the driver from whatever identifier was handed over ─────
    const [who] = await AppDataSource.query(
        `SELECT u.id, u."firstName", u."lastName", u.email, u.phone, dp.status
           FROM "user" u LEFT JOIN driver_profile dp ON dp."userId" = u.id::text
          WHERE u.id::text = $1 OR lower(u.email) = lower($1) OR u.phone = $1
          LIMIT 1`, [ARG]);
    if (!who) { console.error(`No user matches "${ARG}".`); process.exit(1); }
    const driverId: string = who.id;

    head(`DRIVER  ${who.firstName ?? ''} ${who.lastName ?? ''}`.trim());
    line('userId', driverId);
    line('profile status', who.status ?? '(no driver profile)');

    // ── 1. Intent ───────────────────────────────────────────────────────
    head('1. WORK INTENT  (durable — only a decision changes it)');
    const intent = await AppDataSource.getRepository(DriverPresenceIntent)
        .findOne({ where: { driverId } });
    if (!intent) {
        line('intent', 'NO ROW — driver has never declared');
    } else {
        line('state', intent.state);
        line('since', `${new Date(intent.since).toISOString()}  (${ago(intent.since)})`);
        line('set by', `${intent.setBy}${intent.actorId ? ' / ' + intent.actorId : ''}`);
        line('reason', intent.reason);
        line('last reachable', `${intent.lastReachableAt ? new Date(intent.lastReachableAt).toISOString() : '—'}  (${ago(intent.lastReachableAt)})`);
        line('last wake attempt', `${intent.lastWakeAttemptAt ? new Date(intent.lastWakeAttemptAt).toISOString() : '—'}  (${ago(intent.lastWakeAttemptAt)})`);
        line('failed wakes', intent.failedWakeCount);
    }

    // ── 2. Device health ────────────────────────────────────────────────
    head('2. DEVICE HEALTH  (observed — never rewrites intent)');
    const [available, availTtl, lastSeen, lastPos, offlineTomb] = await Promise.all([
        redis.get(`driver:available:${driverId}`),
        redis.ttl(`driver:available:${driverId}`),
        redis.get(`${DispatchService.DRIVER_LASTSEEN_PREFIX}${driverId}`),
        redis.get(`${DispatchService.DRIVER_LASTPOS_PREFIX}${driverId}`),
        redis.get(`driver:offline:${driverId}`),
    ]);
    const geo = await redis.geopos('drivers:locations', driverId).catch(() => null);
    let pos: any = null; try { pos = lastPos ? JSON.parse(lastPos) : null; } catch { /* ignore */ }

    line('availability key', available === 'true' ? `PRESENT (ttl ${availTtl}s)` : 'ABSENT — phone is quiet');
    line('last heartbeat', lastSeen ? `${new Date(Number(lastSeen)).toISOString()}  (${ago(new Date(Number(lastSeen)))})` : '—');
    line('last known position', pos ? `${pos.lat}, ${pos.lng}` : '—');
    line('position taken', pos ? `${new Date(pos.at).toISOString()}  (${ago(new Date(pos.at))})` : '—');
    line('in live geo index', geo && geo[0] ? `YES  ${geo[0][1]}, ${geo[0][0]}` : 'no');
    line('deliberate-offline tomb', offlineTomb ? `set ${ago(new Date(Number(offlineTomb)))}` : 'none');

    const tokens = await AppDataSource.query(
        `SELECT platform, COALESCE("isActive",true) AS active, "updatedAt"
           FROM device_token WHERE "userId" = $1 AND role = 'driver'
          ORDER BY "updatedAt" DESC LIMIT 5`, [driverId]);
    line('push tokens', tokens.length === 0 ? 'NONE — cannot be woken'
        : tokens.map((t: any) => `${t.platform}${t.active ? '' : '(inactive)'} ${ago(t.updatedAt)}`).join(', '));

    // Reachability, computed the same way dispatch computes it.
    const { DriverIntentService } = require('../services/driver_intent_service');
    const health = await DriverIntentService.healthOf(driverId);
    line('REACHABILITY', health.reachability);

    // ── 3. Rides in the window ──────────────────────────────────────────
    head(`3. NEARBY RIDE REQUESTS  (last ${WINDOW_MIN} min)`);
    const rides = await AppDataSource.query(
        `SELECT "rideId", status, "outcomeReason", "createdAt", "driverId",
                "pickupLat" AS lat, "pickupLng" AS lng
           FROM ride
          WHERE "createdAt" > now() - ($1 || ' minutes')::interval
          ORDER BY "createdAt" DESC LIMIT 20`, [String(WINDOW_MIN)]);
    if (rides.length === 0) console.log('  (none)');
    for (const r of rides) {
        const mine = r.driverId === driverId ? '  ← ASSIGNED TO THIS DRIVER' : '';
        console.log(`  ${new Date(r.createdAt).toISOString()}  ${r.rideId}  ${r.status}/${r.outcomeReason ?? '—'}${mine}`);
    }

    // ── 4. Dispatch trail for those rides, for THIS driver ──────────────
    head('4. DISPATCH TRAIL  (what dispatch saw and did about this driver)');
    const events = await AppDataSource.query(
        `SELECT e."rideId", e.sequence, e."eventType", e."dispatchRound",
                e."distanceKm", e."heartbeatAgeMs", e."locationAgeMs",
                e."createdAt", e.detail
           FROM dispatch_event e
          WHERE e."createdAt" > now() - ($1 || ' minutes')::interval
            AND (e."driverId" = $2 OR e."driverId" IS NULL)
          ORDER BY e."createdAt" ASC, e.sequence ASC LIMIT 200`,
        [String(WINDOW_MIN), driverId]);
    if (events.length === 0) console.log('  (no dispatch events in window)');
    for (const e of events) {
        const bits = [
            e.dispatchRound != null ? `round=${e.dispatchRound}` : null,
            e.distanceKm != null ? `${Number(e.distanceKm).toFixed(2)}km` : null,
            e.heartbeatAgeMs != null ? `hb=${Math.round(e.heartbeatAgeMs / 1000)}s` : null,
            e.locationAgeMs != null ? `loc=${Math.round(e.locationAgeMs / 1000)}s` : null,
        ].filter(Boolean).join('  ');
        console.log(`  ${new Date(e.createdAt).toISOString()}  ${String(e.eventType).padEnd(24)} ${e.rideId}  ${bits}`);
        if (e.detail) console.log(`      ${JSON.stringify(e.detail).slice(0, 220)}`);
    }

    // ── 5. What only the handset knows ──────────────────────────────────
    head('5. ON-DEVICE EVENTS  (not visible from here)');
    console.log('  wake_received / wake_answered / wake_failed are written by the app to');
    console.log('  its local ReliabilityLog. They do NOT ship to the server, so read them');
    console.log('  from the in-app Diagnostics screen, or over USB with:');
    console.log('      adb logcat -s flutter | grep KEKE_REL');
    console.log('');
    console.log('  Server-side, a wake that was ANSWERED is provable regardless: the');
    console.log('  heartbeat lands, the availability key reappears, and the position');
    console.log('  timestamp above moves to within seconds of the wake attempt.');

    await AppDataSource.destroy();
})().catch((e) => { console.error('FATAL', e?.message ?? e); process.exit(1); });
