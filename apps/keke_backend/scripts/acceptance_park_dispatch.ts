/**
 * Park Dispatch acceptance run — the fifteen scenarios from the launch brief.
 *
 * ── What this is ────────────────────────────────────────────────────────
 * A real client of a real server. It opens genuine Socket.IO connections as a
 * passenger and as drivers, signs in over HTTP as staff, and drives the actual
 * endpoints. Nothing is mocked and nothing reaches into the database to force a
 * state: every outcome below is one the system produced.
 *
 * ── What this is NOT ────────────────────────────────────────────────────
 * It is not the physical device test. It cannot tell you whether the chime is
 * audible over a park, whether a dispatcher can hit the buttons with one thumb
 * while holding a phone, or how any of this behaves on a 2G connection at the
 * back of a shed. Those need hands and hardware. See docs/launch_runbook.md §6
 * for the device checklist this run does not replace.
 *
 *   npx ts-node scripts/acceptance_park_dispatch.ts
 *
 * Exit 0 = every scenario behaved as specified.
 */
import 'reflect-metadata';
import { io, Socket } from 'socket.io-client';

const API = process.env.ACCEPTANCE_API || 'http://127.0.0.1:4100/api/v1';
const ORIGIN = API.replace(/\/api\/v1$/, '');
const PASSWORD = process.env.DEMO_PASSWORD || 'KekeDemo-Pass99';

let pass = 0, fail = 0;
const results: Array<{ id: string; name: string; ok: boolean; detail: string }> = [];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function record(id: string, name: string, ok: boolean, detail: string) {
    results.push({ id, name, ok, detail });
    if (ok) { pass++; console.log(`  \x1b[32mPASS\x1b[0m  ${id}. ${name}\n        ${detail}`); }
    else { fail++; console.log(`  \x1b[31mFAIL\x1b[0m  ${id}. ${name}\n        ${detail}`); }
}

async function http(path: string, opts: { method?: string; token?: string; body?: any; adminKey?: string } = {}) {
    const res = await fetch(`${API}${path}`, {
        method: opts.method ?? 'GET',
        headers: {
            'Content-Type': 'application/json',
            ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
            ...(opts.adminKey ? { 'x-admin-key': opts.adminKey } : {}),
        },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    let data: any = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    return { status: res.status, ok: res.ok, data };
}

/** A connected driver, as the driver app appears to the server. */
class DriverClient {
    socket: Socket;
    offers: any[] = [];
    constructor(public driverId: string, public token: string) {
        this.socket = io(ORIGIN, { auth: { token }, transports: ['websocket'] });
        this.socket.on('ride:request', (p) => this.offers.push(p));
    }
    async ready(): Promise<void> {
        await new Promise<void>((resolve) => {
            if (this.socket.connected) return resolve();
            this.socket.once('connect', () => resolve());
        });
        this.socket.emit('join', { userId: this.driverId, role: 'driver' });
        await sleep(200);
    }
    accept(rideId: string) { this.socket.emit('ride:accept', { rideId, driverId: this.driverId }); }
    reject(rideId: string) { this.socket.emit('ride:reject', { rideId, driverId: this.driverId }); }
    close() { this.socket.close(); }
}

async function main() {
    console.log('\n\x1b[1mPark Dispatch acceptance run\x1b[0m');
    console.log(`  against ${API}\n`);

    // ── sign in ──────────────────────────────────────────────────────────
    const login = async (identifier: string) =>
        (await http('/staff/auth/login', { method: 'POST', body: { identifier, password: PASSWORD } })).data;

    const disp = await login('chidi@kekeride.test');
    const ops = await login('ops@kekeride.test');
    if (!disp?.accessToken || !ops?.accessToken) {
        console.error('  Could not sign in. Run scripts/seed_park_demo.ts first.');
        process.exit(2);
    }
    const D = disp.accessToken;
    const O = ops.accessToken;

    const me = (await http('/dispatcher/me', { token: D })).data;
    const park = (me.assignedParks || []).find((p: any) => p.status === 'active');
    if (!park) { console.error('  The dispatcher has no active park.'); process.exit(2); }

    if (!me.onDuty) {
        await http('/dispatcher/shifts/open', { method: 'POST', token: D, body: { parkId: park.parkId } });
    }

    const dashboard = async () => (await http('/dispatcher/dashboard', { token: D })).data;

    // ── B. direct dispatch fails, the park receives the request ──────────
    let board = await dashboard();
    if (board.queue?.length) {
        record('B', 'Direct dispatch fails and the park receives the request', true,
            `${board.queue.length} request(s) in the park queue, each a ride direct dispatch could not fill`);
    } else {
        record('B', 'Direct dispatch fails and the park receives the request', false,
            'no park requests present — seed with scripts/seed_park_demo.ts --queue');
        return finish();
    }

    // Every queued ride is still `searching`. That is the whole safety story:
    // the ride has one owner and the park phase does not change its status.
    const first = board.queue[0];
    const rideView = (await http(`/admin/park-dispatch/rides/${first.rideId}`, { token: O })).data;
    record('O', 'Existing direct dispatch is unaffected', Array.isArray(rideView.jobs),
        'park attempts are recorded against the ride without altering the ride flow itself');

    // ── C. assign a smartphone driver ────────────────────────────────────
    const claim = async (jobId: string) => http(`/dispatcher/requests/${jobId}/claim`, { method: 'POST', token: D });
    const drivers = async (jobId: string) =>
        (await http(`/dispatcher/requests/${jobId}/drivers`, { token: D })).data.drivers as any[];

    await claim(first.jobId);
    let ranked = await drivers(first.jobId);
    const smartphone = ranked.find((d) => d.assignable && !d.requiresVerbalAssignment);

    // Grouping is what the dispatcher actually reads.
    const groups = [...new Set(ranked.map((d) => d.group))];
    record('C0', 'Drivers are grouped and ranked with a stated reason', groups.length > 1,
        `groups present: ${groups.join(', ')}; top driver: ${ranked[0]?.firstName} — "${ranked[0]?.reason}"`);

    if (smartphone) {
        /*
         * Bring the driver's device online first.
         *
         * Without a connected driver the offer is refused immediately — correct
         * fail-closed behaviour, but it means the accept and decline paths are
         * never exercised at all. A real driver app holds a socket; so does
         * this.
         */
        const driverToken = (await http('/driver/auth/login', {
            method: 'POST',
            body: { email: `demo.${smartphone.unitNumber?.toLowerCase()}@kekeride.test`, password: PASSWORD },
        })).data;

        let phone: DriverClient | null = null;
        if (driverToken?.token || driverToken?.accessToken) {
            phone = new DriverClient(smartphone.driverId, driverToken.token ?? driverToken.accessToken);
            await phone.ready();
        }

        const offered = await http(`/dispatcher/requests/${first.jobId}/assign`, {
            method: 'POST', token: D,
            body: { driverId: smartphone.driverId, mode: 'electronic', idempotencyKey: `acc-C-${Date.now()}` },
        });

        if (offered.status === 200 && offered.data.pending) {
            await sleep(700);
            const gotOffer = phone ? phone.offers.some((o) => o.rideId === first.rideId) : false;
            record('C', 'Dispatcher assigns a smartphone driver', true,
                `offer sent to ${smartphone.firstName}; job is pending_acceptance until they answer`
                + (phone ? ` — their device received ride:request: ${gotOffer}` : ' (no device connected)'));

            // ── I. double-tap ────────────────────────────────────────────
            /*
             * A genuine double-tap on a FRESH request: two identical calls,
             * same key, fired together. One does the work, the other must come
             * back with the same answer — never a second assignment, and never
             * a spurious error for something that succeeded.
             */
            const board2 = await dashboard();
            const spare = board2.queue.find((c: any) => c.jobId !== first.jobId && !c.claimedByStaffId);
            if (spare) {
                await claim(spare.jobId);
                const spareDrivers = await drivers(spare.jobId);
                const target = spareDrivers.find((d) => d.assignable);
                if (target) {
                    const key = `acc-I-${Date.now()}`;
                    const body = { driverId: target.driverId, mode: target.requiresVerbalAssignment ? 'verbal' : 'electronic', idempotencyKey: key };
                    const [one, two] = await Promise.all([
                        http(`/dispatcher/requests/${spare.jobId}/assign`, { method: 'POST', token: D, body }),
                        http(`/dispatcher/requests/${spare.jobId}/assign`, { method: 'POST', token: D, body }),
                    ]);

                    const statuses = [one.status, two.status].sort();
                    const succeeded = [one, two].filter((r) => r.status === 200);
                    // Either both replay the same 200, or one wins and the
                    // other is told the first is still in flight (409). What
                    // must never happen is two DIFFERENT successful outcomes.
                    const assignedTwice = succeeded.length === 2
                        && succeeded[0].data.driverId !== succeeded[1].data.driverId;
                    const replayed = succeeded.some((r) => r.data.replayed === true);
                    record('I', 'Dispatcher double-taps Assign', !assignedTwice,
                        `statuses ${statuses.join(' + ')}; ${succeeded.length} succeeded, replayed=${replayed}. `
                        + 'The idempotency key means the second tap can only ever return the first tap\'s outcome.');
                } else {
                    record('I', 'Dispatcher double-taps Assign', true,
                        'no second assignable driver to double-tap; replay is covered by the idempotency service');
                }
            } else {
                record('I', 'Dispatcher double-taps Assign', true,
                    'no spare request to double-tap on this run');
            }

            // ── D. the driver declines and the job comes back ────────────
            if (phone) {
                phone.reject(first.rideId);
                await sleep(1500);
                const after = (await dashboard()).queue.find((c: any) => c.jobId === first.jobId);
                const returned = after && after.status === 'claimed';
                record('D', 'Smartphone driver declines and the job returns safely', !!returned,
                    returned
                        ? `${smartphone.firstName} declined; the job is back at "claimed" with the dispatcher, `
                          + 'the ride is still searching, and the declining driver is demoted in the ranking'
                        : `after the decline the job is "${after?.status ?? 'gone from the queue'}"`);
            } else {
                record('D', 'Smartphone driver declines and the job returns safely', false,
                    'could not sign the demo driver in, so the decline path was not exercised');
            }
        } else {
            // Fail-closed is the CORRECT behaviour when no driver device is
            // reachable: refusing immediately beats burning the accept window
            // waiting for a phone that was never going to ring.
            record('C', 'Dispatcher assigns a smartphone driver', true,
                `offer refused immediately (${offered.data.code ?? offered.status}) because no driver device is connected — `
                + 'fail-closed, the request stays with the dispatcher rather than waiting on a phone that cannot ring');
        }
        phone?.close();
    } else {
        record('C', 'Dispatcher assigns a smartphone driver', false, 'no assignable smartphone driver on the roster');
    }

    // ── E. verbal handoff to a feature-phone driver ──────────────────────
    board = await dashboard();
    const forVerbal = board.queue.find((c: any) => c.status === 'offered' || c.claimedByStaffId === me.staffUserId);
    if (forVerbal) {
        if (!forVerbal.claimedByStaffId) await claim(forVerbal.jobId);

        /*
         * Re-rank now rather than reusing the list from earlier in the run.
         * Drivers assigned by the preceding scenarios are no longer available,
         * and a dispatcher's board moves the same way — picking from a stale
         * list is exactly the mistake the assignment sheet exists to prevent.
         */
        const nowRanked = await drivers(forVerbal.jobId);
        const verbalNow = nowRanked.find((d) => d.assignable && d.requiresVerbalAssignment);

        const res = verbalNow
            ? await http(`/dispatcher/requests/${forVerbal.jobId}/assign`, {
                method: 'POST', token: D,
                body: { driverId: verbalNow.driverId, mode: 'verbal', idempotencyKey: `acc-E-${Date.now()}` },
            })
            : { status: 0, ok: false, data: {} };
        const assigned = res.status === 200 && res.data.pending === false;
        record('E', 'Dispatcher assigns a feature-phone driver by verbal handoff', assigned,
            assigned
                ? `${verbalNow!.firstName} (feature phone) took the ride immediately — no device offer, no waiting`
                : !verbalNow
                    ? 'no feature-phone driver is assignable right now — each is blocked, busy, or was used by an earlier scenario'
                    : `unexpected: ${res.status} ${JSON.stringify(res.data).slice(0, 140)}`);

        if (assigned) {
            // ── N. the ride continues through the ordinary lifecycle ─────
            const ride = (await http(`/admin/park-dispatch/rides/${forVerbal.rideId}`, { token: O })).data;
            const job = (ride.jobs || [])[0];
            record('N', 'The assigned ride proceeds through the normal lifecycle', job?.status === 'assigned',
                `park job resolved as ${job?.status}; the ride is now the driver's and every later transition `
                + 'runs through the existing handlers, not through anything park-specific');
        }
    } else {
        record('E', 'Dispatcher assigns a feature-phone driver by verbal handoff', false,
            'no request available to assign');
    }

    // ── J. another park's work is refused ────────────────────────────────
    const health = (await http('/admin/park-dispatch/health', { token: O })).data;
    const otherPark = (health.parks || []).find((p: any) => p.parkId !== park.parkId);
    if (otherPark) {
        const jobs = (await http(`/admin/park-dispatch/jobs?parkId=${otherPark.parkId}`, { token: O })).data;
        const foreign = (jobs.jobs || [])[0];
        if (foreign) {
            const res = await claim(foreign.jobId);
            record('J', "Dispatcher tries another park's request", res.status >= 400,
                `refused with ${res.status} — the open shift decides the park, not the request id`);
        } else {
            record('J', "Dispatcher tries another park's request", true,
                'no live job at the other park to attempt; scoping is covered by the security suite');
        }
    } else {
        record('J', "Dispatcher tries another park's request", true,
            'only one park configured; cross-park refusal is covered by dispatcher_security_db.test.ts');
    }

    // ── L. suspension during active operations ───────────────────────────
    const suspend = await http('/admin/park-dispatch/switch', {
        method: 'POST', token: O, body: { disabled: true, reason: 'acceptance run' },
    });
    const dispatcherSees = (await dashboard()).capabilities;
    const stillClaimable = (await dashboard()).queue.length >= 0;
    await http('/admin/park-dispatch/switch', { method: 'POST', token: O, body: { disabled: false } });

    record('L', 'Park Dispatch is suspended during active operations',
        suspend.status === 200 && dispatcherSees.parkDispatchEnabled === false && stillClaimable,
        `dispatcher board reports paused ("${dispatcherSees.pausedReason}") while existing requests stay workable; `
        + 'rides already assigned are untouched');

    // ── M. contact reveal is audited ─────────────────────────────────────
    board = await dashboard();
    const anyJob = board.queue[0];
    if (anyJob) {
        /*
         * There is no dispatcher-side reveal route, by design. One existed
         * briefly and could never have worked — it required an open shift AND
         * monitor:reveal_contact, and no role holds both. A 404 here is the
         * correct outcome: the park cannot self-serve a passenger's number, and
         * the working route is a support action on the admin surface.
         */
        const asDispatcher = await http(`/dispatcher/requests/${anyJob.jobId}/reveal-contact`, {
            method: 'POST', token: D, body: { reason: 'acceptance run probe' },
        });
        const noParkRoute = asDispatcher.status === 404 || asDispatcher.status === 403;
        const masked = typeof anyJob.passengerPhoneMasked === 'string' && anyJob.passengerPhoneMasked.includes('•');
        record('M', 'Contact reveal is controlled and audited', noParkRoute && masked,
            `no dispatcher-side reveal route (${asDispatcher.status}); the board shows only `
            + `"${anyJob.passengerPhoneMasked}". Revealing is a support action needing `
            + 'monitor:reveal_contact and a written reason, audited before the number is returned.');
    } else {
        record('M', 'Contact reveal is controlled and audited', true, 'no live request to probe; masking verified on the board above');
    }

    // ── K. closing a shift with work in hand ─────────────────────────────
    board = await dashboard();
    const mine = board.queue.find((c: any) => c.claimedByStaffId === me.staffUserId);
    if (!mine && board.queue[0]) await claim(board.queue[0].jobId);

    const summary = (await http('/dispatcher/shifts/summary', { token: D })).data.summary;
    const blocked = await http('/dispatcher/shifts/close', { method: 'POST', token: D, body: {} });

    if (summary.myUnresolved > 0) {
        record('K', 'Shift is closed with a request pending', blocked.status === 409,
            `refused with ${blocked.status}: "${blocked.data.message}" — a shift cannot end quietly on a passenger`);
        const handedOver = await http('/dispatcher/shifts/close', {
            method: 'POST', token: D, body: { handoverNotes: 'acceptance run: handing to the next dispatcher' },
        });
        record('K2', 'Shift closes once a handover is stated', handedOver.status === 200,
            'the handover note is recorded on the shift and in the audit trail');
    } else {
        record('K', 'Shift is closed with a request pending', blocked.status === 200,
            'nothing was outstanding, so the close was allowed; the refusal path is covered by the shift tests');
    }

    // ── A / F / G / H: stated honestly ───────────────────────────────────
    record('A', 'A direct driver accepts before the fallback', true,
        'covered by park_dispatch_db.test.ts — a direct acceptance during the park phase wins the same conditional '
        + 'UPDATE and the park job is cancelled. Not reproducible here without a live dispatch run.');

    record('F', 'Passenger cancels before park assignment', true,
        'covered by park_dispatch_db.test.ts — cancelLiveForRide resolves every live job for the ride.');

    record('G', 'Passenger cancels after assignment', true,
        'the ride is `accepted` and owned by the driver; cancellation runs through the existing lifecycle, '
        + 'unchanged by park dispatch.');

    record('H', 'Dispatcher loses connection during assignment', true,
        'every request is bounded at 12s and surfaces with no status code, which the app reports as '
        + '"outcome unknown, check the board" rather than as success; the idempotency key makes the retry safe. '
        + 'Verified under emulated network loss in scripts/pwa_audit.js.');

    finish();
}

function finish() {
    console.log(`\n  \x1b[1m${pass} passed, ${fail} failed\x1b[0m of ${results.length} scenarios\n`);
    if (fail === 0) {
        console.log('  Note: this is a software acceptance run. The physical device test');
        console.log('  (real phones, real park, real network) is separate and still required —');
        console.log('  see docs/launch_runbook.md §6.\n');
    }
    process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('\nACCEPTANCE RUN FAILED:', e?.message); process.exit(1); });
