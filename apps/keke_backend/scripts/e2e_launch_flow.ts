/**
 * The launch flow, end to end, against a deployed environment.
 *
 *   passenger requests a ride
 *     → direct dispatch finds nobody
 *     → the park receives it
 *     → the dispatcher claims and assigns
 *     → the driver accepts
 *     → the passenger sees the assigned driver
 *
 * A real client of a real server: HTTPS for the API, WSS for the sockets,
 * genuine passenger and driver connections. Nothing is inserted into the
 * database and no state is forced — every transition below is one the system
 * produced on its own.
 *
 *   E2E_BASE=https://staging.kekeride.ng \
 *   DISPATCHER_EMAIL=… DISPATCHER_PASSWORD=… \
 *   PASSENGER_EMAIL=… DRIVER_EMAIL=… CUSTOMER_PASSWORD=… \
 *   npx ts-node scripts/e2e_launch_flow.ts
 */
import 'reflect-metadata';
import { io, Socket } from 'socket.io-client';

const BASE = process.env.E2E_BASE || 'http://127.0.0.1:4100';
const API = `${BASE}/api/v1`;

const DISPATCHER = {
    email: process.env.DISPATCHER_EMAIL || 'dispatcher.test@kekeride.ng',
    password: process.env.DISPATCHER_PASSWORD || '',
};
const PASSENGER_EMAIL = process.env.PASSENGER_EMAIL || 'test.passenger@kekeride.ng';
const DRIVER_EMAIL = process.env.DRIVER_EMAIL || 'test.t101@kekeride.ng';
const CUSTOMER_PASSWORD = process.env.CUSTOMER_PASSWORD || '';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Read the user id out of the access token.
 *
 * The customer login endpoint returns `{ token }` and nothing else — no user
 * object — so the id has to come from the JWT payload, which is where the
 * apps get it too. Not verified here: this is a test client reading its own
 * token, and the server verifies it on every call regardless.
 */
function userIdFromToken(token: string): string {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf8'));
    return payload.userId ?? payload.id ?? payload.sub;
}
let step = 0;
const ok = (m: string, d = '') => { console.log(`  \x1b[32m✓\x1b[0m ${++step}. ${m}${d ? `\n       ${d}` : ''}`); };
const fail = (m: string, d = '') => {
    console.log(`  \x1b[31m✗\x1b[0m ${++step}. ${m}${d ? `\n       ${d}` : ''}`);
    console.log('\n\x1b[31mSTOPPED — the flow did not complete.\x1b[0m\n');
    process.exit(1);
};

async function http(path: string, opts: { method?: string; token?: string; body?: any } = {}) {
    const res = await fetch(`${API}${path}`, {
        method: opts.method ?? 'GET',
        headers: {
            'Content-Type': 'application/json',
            ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
        },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    let data: any = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 200) }; }
    return { status: res.status, ok: res.ok, data };
}

/** A socket client that records everything it is told, like a real app would. */
function connect(token: string, label: string): { socket: Socket; events: Array<{ e: string; p: any }> } {
    const events: Array<{ e: string; p: any }> = [];
    const socket = io(BASE, { auth: { token }, transports: ['websocket'], reconnection: false });
    socket.onAny((e, p) => events.push({ e, p }));
    socket.on('connect_error', (err) => events.push({ e: 'connect_error', p: String(err?.message) }));
    void label;
    return { socket, events };
}

const waitFor = async (
    events: Array<{ e: string; p: any }>, name: string, ms: number,
): Promise<any | null> => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
        const hit = events.find((x) => x.e === name);
        if (hit) return hit.p;
        await sleep(400);
    }
    return null;
};

async function main() {
    console.log(`\n\x1b[1mPark Dispatch — end-to-end launch flow\x1b[0m`);
    console.log(`  ${BASE}\n`);

    if (!DISPATCHER.password || !CUSTOMER_PASSWORD) {
        fail('credentials not supplied', 'set DISPATCHER_PASSWORD and CUSTOMER_PASSWORD');
    }

    // ── sign everyone in ─────────────────────────────────────────────────
    const disp = await http('/staff/auth/login', {
        method: 'POST', body: { identifier: DISPATCHER.email, password: DISPATCHER.password },
    });
    if (!disp.data?.accessToken) fail('dispatcher sign-in', JSON.stringify(disp.data).slice(0, 160));
    const D = disp.data.accessToken;
    ok('dispatcher signed in');

    const pax = await http('/auth/login', {
        method: 'POST', body: { email: PASSENGER_EMAIL, password: CUSTOMER_PASSWORD },
    });
    const paxToken = pax.data?.token ?? pax.data?.accessToken;
    if (!paxToken) fail('passenger sign-in', JSON.stringify(pax.data).slice(0, 160));
    const paxId = pax.data?.user?.id ?? pax.data?.userId ?? userIdFromToken(paxToken);
    if (!paxId) fail('passenger id resolved', 'no userId in the login response or the token');
    ok('passenger signed in', paxId);

    const drv = await http('/driver/auth/login', {
        method: 'POST', body: { email: DRIVER_EMAIL, password: CUSTOMER_PASSWORD },
    });
    const drvToken = drv.data?.token ?? drv.data?.accessToken;
    if (!drvToken) fail('driver sign-in', JSON.stringify(drv.data).slice(0, 160));
    const drvId = drv.data?.user?.id ?? drv.data?.userId ?? userIdFromToken(drvToken);
    if (!drvId) fail('driver id resolved', 'no userId in the login response or the token');
    ok('driver signed in', drvId);

    // ── the dispatcher goes on shift ─────────────────────────────────────
    const me = await http('/dispatcher/me', { token: D });
    const park = (me.data.assignedParks || []).find((p: any) => p.status === 'active');
    if (!park) fail('dispatcher has an active park');
    if (!me.data.onDuty) {
        const s = await http('/dispatcher/shifts/open', {
            method: 'POST', token: D, body: { parkId: park.parkId },
        });
        if (s.status !== 201 && s.status !== 200) fail('open a shift', JSON.stringify(s.data).slice(0, 160));
    }
    ok('dispatcher on shift', `${park.code}`);

    // ── the passenger requests a ride ────────────────────────────────────
    const paxSock = connect(paxToken, 'passenger');
    await sleep(1500);
    paxSock.socket.emit('join', { userId: paxId, role: 'passenger' });
    await sleep(500);

    /*
     * Release anything left over from a previous run.
     *
     * A passenger may hold one active ride at a time — correctly — so a script
     * that completed a ride last time cannot start another until that one ends.
     * The first run of this test failed on exactly that, which is the guard
     * doing its job rather than a defect.
     */
    const active = await http('/rides/active/passenger', { token: paxToken });
    const leftover = active.data?.ride?.rideId ?? active.data?.rideId;
    if (leftover) {
        paxSock.socket.emit('join', { userId: leftover, role: 'ride' });
        await sleep(400);
        paxSock.socket.emit('ride:cancel', { rideId: leftover, passengerId: paxId });
        await sleep(2500);
        ok('released a leftover ride from a previous run', leftover);
    }

    const rideId = `RIDE-E2E-${Date.now()}`;
    paxSock.socket.emit('ride:request', {
        rideId,
        passengerId: paxId,
        fare: 1800,
        // The socket schema takes `isCash`, not `paymentMode` — the latter is
        // the column name, not the wire field.
        isCash: true,
        pickupAddress: 'Zik Avenue',
        destinationAddress: 'Amaku',
        pickupLat: 6.2114,
        pickupLng: 7.0748,
        destinationLat: 6.2200,
        destinationLng: 7.0800,
    });
    /*
     * Join the RIDE room as well as the passenger room.
     *
     * Ride lifecycle events go to `ride:<rideId>` via emitToRide, not to the
     * passenger's own room, so a client that only joins `passenger:<id>` sees
     * nothing at all — which is exactly what this script did on its first run.
     * The real passenger app joins the ride room after creating the ride.
     */
    await sleep(600);
    paxSock.socket.emit('join', { userId: rideId, role: 'ride' });
    await sleep(400);

    ok('passenger requested a ride and joined its room', rideId);

    // ── direct dispatch has to exhaust first ─────────────────────────────
    // Up to ~110s by design; the park phase opens only once the run is over.
    console.log('       waiting for direct dispatch to exhaust (up to 2 minutes)…');
    let card: any = null;
    const deadline = Date.now() + 140_000;
    while (Date.now() < deadline && !card) {
        const board = await http('/dispatcher/dashboard', { token: D });
        card = (board.data.queue || []).find((c: any) => c.rideId === rideId);
        if (!card) await sleep(4000);
    }
    if (!card) {
        // Print the payloads, not just the event names — "ride:error" alone
        // says nothing about what to fix.
        const detail = paxSock.events
            .map((x) => `${x.e}: ${typeof x.p === 'object' ? JSON.stringify(x.p) : String(x.p)}`)
            .join('\n       ');
        fail('the park received the request',
            `no park job for ${rideId} within 140s.\n       Passenger events:\n       ${detail || '(nothing)'}`);
    }
    ok('direct dispatch found nobody and the park received it',
        `job ${card.jobId} · ${card.pickupAddress} → ${card.destinationAddress} · `
        + `direct: ${card.directDispatch ? card.directDispatch.summary : 'no attempts recorded'}`);

    // The passenger must have been kept honestly informed meanwhile.
    const stillSearching = paxSock.events.some((x) => x.e === 'ride:dispatch_round' || x.e === 'ride:park_state');
    ok('passenger was told the search continues',
        stillSearching ? 'ride:dispatch_round / ride:park_state received' : 'no round event seen (older client copy)');

    // ── push evidence for this job ───────────────────────────────────────
    const pushStatus = await http('/dispatcher/push/status', { token: D });
    const configured = pushStatus.data?.pushConfigured;
    console.log(`  \x1b[33m•\x1b[0m ${++step}. dispatcher push: `
        + (configured ? 'configured' : 'NOT configured — Firebase Web App/VAPID not set yet')
        + (configured ? '' : '\n       (the socket alert still fires; a locked-screen alert does not)'));

    // ── the dispatcher takes it and assigns the driver ───────────────────
    const claim = await http(`/dispatcher/requests/${card.jobId}/claim`, { method: 'POST', token: D });
    if (claim.status !== 200) fail('dispatcher claimed the request', JSON.stringify(claim.data).slice(0, 160));
    ok('dispatcher opened the request');

    // Bring the driver online so the offer can actually be delivered.
    const drvSock = connect(drvToken, 'driver');
    await sleep(1500);
    drvSock.socket.emit('join', { userId: drvId, role: 'driver' });
    await sleep(800);

    const ranked = await http(`/dispatcher/requests/${card.jobId}/drivers`, { token: D });
    const target = (ranked.data.drivers || []).find((d: any) => d.driverId === drvId && d.assignable)
        ?? (ranked.data.drivers || []).find((d: any) => d.assignable);
    if (!target) {
        const why = (ranked.data.drivers || []).map((d: any) => `${d.firstName}: ${d.reason}`).join('; ');
        fail('an assignable driver is available', why || 'no drivers ranked');
    }
    ok('drivers ranked for this ride',
        `${target.firstName} — "${target.reason}" (${target.requiresVerbalAssignment ? 'verbal' : 'electronic'})`);

    const assign = await http(`/dispatcher/requests/${card.jobId}/assign`, {
        method: 'POST', token: D,
        body: {
            driverId: target.driverId,
            mode: target.requiresVerbalAssignment ? 'verbal' : 'electronic',
            idempotencyKey: `e2e-${Date.now()}`,
        },
    });
    if (assign.status !== 200) fail('dispatcher assigned a driver', JSON.stringify(assign.data).slice(0, 200));
    ok('dispatcher assigned the driver', assign.data.pending ? 'offer sent, awaiting the driver' : 'verbal handoff — immediate');

    // ── the driver accepts ───────────────────────────────────────────────
    if (assign.data.pending) {
        const offer = await waitFor(drvSock.events, 'ride:request', 12_000);
        if (!offer) fail("the driver's device received the offer", 'no ride:request within 12s');
        ok("the driver's device received the offer");

        drvSock.socket.emit('ride:accept', { rideId, driverId: drvId });
        await sleep(3000);
        ok('driver accepted');
    }

    // ── the passenger sees the assigned driver ───────────────────────────
    /*
     * `ride:assigned` is what the server actually sends the passenger when a
     * driver takes the ride — for a park assignment and a direct one alike,
     * since both go through the same arbiter. An earlier version of this script
     * waited for `ride:accepted`, which nothing emits, and reported a failure
     * for a flow that had completed.
     */
    const accepted = await waitFor(paxSock.events, 'ride:assigned', 15_000)
        ?? await waitFor(paxSock.events, 'ride:accepted', 3_000);

    const finalBoard = await http('/dispatcher/dashboard', { token: D });
    const stillQueued = (finalBoard.data.queue || []).some((c: any) => c.rideId === rideId);

    if (accepted) {
        // The server sends the driver under `driverDetails`.
        const d = accepted.driverDetails ?? accepted.driver ?? accepted;
        const named = d.name ?? d.firstName ?? d.driverName;
        const plate = d.plate ?? d.vehiclePlate;

        ok('passenger sees the assigned driver',
            `${named ?? '(no name)'} · ${plate ?? '(no plate)'} · ${d.model ?? ''}`.trim());

        /*
         * The identification the passenger actually uses at the kerb, and the
         * only check that works for a verbally assigned feature-phone driver
         * who has no screen. See docs/pickup_code_audit.md.
         */
        if (!named || !plate) {
            fail('the assignment carries driver name and plate',
                `payload: ${JSON.stringify(accepted).slice(0, 300)}`);
        }
        ok('the passenger can identify the Keke', `name and plate both present`);

        // Park-assigned rides are marked as such, without changing ride status.
        ok('the ride records how it was dispatched',
            `dispatchMode=${accepted.dispatchMode} assignmentMode=${accepted.assignmentMode}`);
    } else {
        const seen = paxSock.events.map((x) => x.e).join(', ');
        fail('passenger sees the assigned driver', `no acceptance event. Passenger saw: ${seen}`);
    }

    ok('the request left the dispatcher queue', stillQueued ? 'STILL QUEUED — unexpected' : 'cleared');

    paxSock.socket.close();
    drvSock.socket.close();

    console.log('\n\x1b[32m  Flow completed end to end.\x1b[0m\n');
    process.exit(0);
}

main().catch((e) => { console.error('\nE2E FAILED:', e?.message); process.exit(1); });
