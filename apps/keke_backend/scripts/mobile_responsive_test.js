/**
 * Responsive layout test for the dispatcher app, on the phones it actually runs on.
 *
 * ── What this checks, and why it is not a screenshot review ──────────────
 * The bugs this exists to catch are not visual. "End shift" was
 * `display: none` on every screen under 560px, and the shift gate was a fixed,
 * vertically-centred card with no overflow rule, so on a short phone its top
 * and bottom were both cut off with nothing able to scroll to them. Neither is
 * obvious from a screenshot — the screenshot just looks like a page — but both
 * are trivially detectable by asking the browser where things are.
 *
 * So every assertion here is a measurement: is the element in the layout at
 * all, does the document scroll, does the control enter the viewport when we
 * scroll to the bottom, is anything sitting under a fixed element.
 *
 * ── Why the workspace is seeded ─────────────────────────────────────────
 * The login and shift-gate screens render without a session and are driven
 * exactly as a dispatcher would meet them. The workspace needs an open shift,
 * which needs a password this script deliberately does not hold. It is instead
 * loaded with representative cards through the app's own render path, so the
 * markup and CSS under test are the real ones — only the data is fixture.
 *
 * Usage:
 *   node scripts/mobile_responsive_test.js [baseUrl]
 *   node scripts/mobile_responsive_test.js https://api.kekeride.ng/dispatch/
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CHROME = process.env.CHROME_BIN
    || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE = process.argv[2] || 'https://api.kekeride.ng/dispatch/';
const SHOTS = process.env.SHOT_DIR || '/tmp/keke-mobile-shots';

/** The phones this app is expected to run on, smallest first. */
const VIEWPORTS = [
    { name: '320x568-iphone-se', width: 320, height: 568 },
    { name: '360x640-android-common', width: 360, height: 640 },
    { name: '360x740-android-tall', width: 360, height: 740 },
    { name: '375x667-iphone-8', width: 375, height: 667 },
    { name: '393x873-pixel', width: 393, height: 873 },
    { name: '412x915-android-large', width: 412, height: 915 },
];

let pass = 0;
let fail = 0;
const failures = [];
const ok = (m) => { console.log(`    PASS  ${m}`); pass += 1; };
const bad = (m) => { console.log(`    FAIL  ${m}`); fail += 1; failures.push(m); };
const check = (cond, m) => (cond ? ok(m) : bad(m));

async function main() {
    fs.mkdirSync(SHOTS, { recursive: true });

    const PORT = 9800 + Math.floor(Math.random() * 300);
    const profile = `/tmp/kkmob-${Date.now()}`;
    const chrome = spawn(CHROME, [
        '--headless=new', '--disable-gpu', '--no-sandbox',
        `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank',
    ], { stdio: 'ignore' });

    let target;
    for (let i = 0; i < 60; i += 1) {
        await sleep(250);
        try {
            const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
            target = list.find((x) => x.type === 'page');
            if (target) break;
        } catch { /* chrome still starting */ }
    }
    if (!target) throw new Error('Chrome did not start');

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener('open', r));

    let msgId = 0;
    const pending = new Map();
    ws.addEventListener('message', (e) => {
        const m = JSON.parse(e.data);
        if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    });
    const send = (method, params = {}) => new Promise((res) => {
        const i = ++msgId;
        pending.set(i, res);
        ws.send(JSON.stringify({ id: i, method, params }));
    });
    const js = async (expression, awaitPromise = false) => {
        const r = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
        return r.result?.result?.value;
    };

    await send('Page.enable');
    await send('Runtime.enable');

    for (const vp of VIEWPORTS) {
        console.log(`\n  ── ${vp.name} (${vp.width}x${vp.height}) ──`);

        await send('Emulation.setDeviceMetricsOverride', {
            width: vp.width, height: vp.height, deviceScaleFactor: 2, mobile: true,
        });
        await send('Page.navigate', { url: BASE });
        await sleep(1800);

        await testLogin(js, vp);
        await testShiftGate(js, vp, send);
        await testWorkspace(js, vp, send);
    }

    await send('Emulation.clearDeviceMetricsOverride');
    ws.close();
    chrome.kill();

    console.log(`\n  ${pass} passed, ${fail} failed`);
    if (failures.length) {
        console.log('\n  Failures:');
        failures.forEach((f) => console.log(`    - ${f}`));
    }
    console.log(`\n  Screenshots: ${SHOTS}`);
    process.exit(fail === 0 ? 0 : 1);
}

/** Geometry helpers evaluated in the page. */
const MEASURE = `
(() => {
    const de = document.documentElement;
    return {
        scrollHeight: de.scrollHeight,
        innerHeight: window.innerHeight,
        scrollWidth: de.scrollWidth,
        innerWidth: window.innerWidth,
        scrollY: window.scrollY,
    };
})()`;

/**
 * Is the element in the layout, and can it be reached by scrolling?
 *
 * `display:none` reports no box at all, which is the exact failure that hid
 * End shift on every phone — so that is checked first and separately from
 * whether it is currently on screen.
 */
const REACHABLE = (sel) => `
(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return { exists: false };
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const rendered = style.display !== 'none' && style.visibility !== 'hidden'
        && (rect.width > 0 || rect.height > 0);
    return {
        exists: true,
        rendered,
        height: Math.round(rect.height),
        top: Math.round(rect.top),
        bottom: Math.round(rect.bottom),
        display: style.display,
    };
})()`;

async function shot(send, name) {
    const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    if (r.result?.data) {
        fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(r.result.data, 'base64'));
    }
}

async function testLogin(js, vp) {
    const m = await js(MEASURE);
    check(m.scrollWidth <= m.innerWidth + 1,
        `login: no horizontal overflow (${m.scrollWidth} <= ${m.innerWidth})`);

    const btn = await js(REACHABLE('#login-btn'));
    check(btn.exists && btn.rendered, 'login: sign-in button is rendered');
    check(btn.height >= 44, `login: sign-in button is at least 44px (${btn.height}px)`);
}

/**
 * The shift gate is the screen that was worst affected: it is the tallest, and
 * it was the one pinned to the viewport and centred.
 */
async function testShiftGate(js, vp, send) {
    await js(`showScreen('shift-gate')`);
    await sleep(250);

    const m = await js(MEASURE);
    check(m.scrollWidth <= m.innerWidth + 1,
        `shift gate: no horizontal overflow (${m.scrollWidth} <= ${m.innerWidth})`);

    // Every control in the setup flow must exist in the layout.
    for (const [sel, label] of [
        ['#sound-test', 'test sound'],
        ['#notif-enable', 'notification permission'],
        ['#push-enable', 'background alerts set-up'],
        ['#shift-start', 'start shift'],
        ['#shift-signout', 'sign out'],
    ]) {
        const el = await js(REACHABLE(sel));
        check(el.exists && el.rendered, `shift gate: ${label} is rendered`);
    }

    /*
     * …and each must be reachable BY SCROLLING.
     *
     * Deliberately not "visible once scrolled to the bottom": on a 568px screen
     * the shift gate is legitimately taller than the viewport, so at maximum
     * scroll the top controls are off-screen and that is correct. What was
     * broken is that they could not be scrolled to at all — the card was fixed
     * and centred, so parts of it were unreachable at every scroll position.
     *
     * So scroll each control into view and confirm it lands inside the viewport.
     */
    for (const [sel, label] of [
        ['#push-enable', 'background-alert set-up'],
        ['#shift-start', '"Start shift"'],
        ['#shift-signout', '"Sign out"'],
    ]) {
        await js(`document.querySelector(${JSON.stringify(sel)}).scrollIntoView({ block: 'center' })`);
        await sleep(200);
        const el = await js(REACHABLE(sel));
        const h = (await js(MEASURE)).innerHeight;
        check(el.top >= 0 && el.bottom <= h + 1,
            `shift gate: ${label} can be scrolled fully into view (top ${el.top}, bottom ${el.bottom}, viewport ${h})`);
    }

    await js('window.scrollTo(0, document.documentElement.scrollHeight)');
    await sleep(250);

    await shot(send, `${vp.name}-shift-gate`);
    await js('window.scrollTo(0, 0)');
}

async function testWorkspace(js, vp, send) {
    /*
     * Seed the board through the app's own render path. The CSS and markup
     * exercised below are the shipped ones; only the data is fixture.
     */
    await js(`(() => {
        showScreen('workspace');
        S.me = { staffUserId: 'test-dispatcher', name: 'Test Dispatcher' };
        S.park = { parkId: 'p1', name: 'Holy Trinity Park', code: 'HOLY' };
        S.shift = { shiftId: 's1', parkId: 'p1', durationMinutes: 42 };
        S.counters = {
            queueDepth: 3, activeAssignments: 1, awaitingDriverResponse: 0, waitingPassengers: 3,
            availableDrivers: 2, driversOnTrips: 1, driversUnavailable: 0, driversOffline: 1,
            parkUtilisationPct: 40, avgPassengerWaitSeconds: 62, dispatcherResponseSeconds: 7,
            jobsAssignedToday: 4, jobsCompletedToday: 3, failedAssignmentsToday: 1, escalatedJobsToday: 0,
        };
        S.queue = Array.from({ length: 4 }, (_, i) => ({
            jobId: 'job-' + i,
            rideId: 'RIDE-178567403773' + i,
            passengerName: 'Alexander Nwabufoh',
            passengerPhoneMasked: '0706' + String.fromCharCode(8226).repeat(4) + '816',
            pickupAddress: 'Onitsha North, Onitsha North, Anambra State, Nigeria',
            destinationAddress: 'Eke Awka Market, Awka South, Anambra State',
            estimatedFare: 14447, isCash: true, waitingSeconds: 32 + i, priorityLabel: 'normal',
            estimatedTravelMinutes: 0, parkToPickupKm: 0, parksTried: 1,
            status: i === 0 ? 'claimed' : 'offered',
            claimedByStaffId: i === 0 ? 'test-dispatcher' : null,
            expiresAt: new Date(Date.now() + 60000).toISOString(),
            directDispatch: { summary: 'No driver was free to ring' },
        }));
        S.drivers = Array.from({ length: 3 }, (_, i) => ({
            driverId: 'driver-' + i,
            firstName: 'Alexnder', lastName: 'Nwabufoh ' + i,
            unitNumber: 'AB-123-CD', vehiclePlate: 'AB-123-CD', vehicleModel: 'Keke NAPEP',
            deviceCapability: i === 2 ? 'feature_phone' : 'smartphone',
            requiresVerbalAssignment: i === 2,
            assignable: i === 0, group: i === 0 ? 'recommended' : 'verification_issue',
            problems: i === 0 ? [] : [{ code: 'no_badge', message: 'No badge issued' }],
            /* badges and recommended are required on the server's
               RecommendedDriver DTO and always sent. Omitting them made
               renderDrivers throw, which silently left the panel empty — the
               fixture lying about the payload, not the app being wrong.
               (No backticks in here: this comment lives inside a template
               literal, and a stray one ends it.) */
            badges: i === 0 ? ['recommended'] : ['no_badge'],
            recommended: i === 0,
            lastAssignedAt: null,
            rating: 4.8, ratingCount: 12, photoUrl: null, presenceState: 'waiting',
        }));
        S.readiness = {
            driversPresent: 1, driversAssignable: 0,
            blockers: [{
                code: 'present_but_unassignable', severity: 'blocking',
                message: '1 driver(s) present but none can be assigned — usually no badge issued, a wallet block, or KYC not approved.',
            }],
        };
        render();
    })()`);
    await sleep(400);

    const m = await js(MEASURE);

    check(m.scrollWidth <= m.innerWidth + 1,
        `workspace: no horizontal overflow (${m.scrollWidth} <= ${m.innerWidth})`);
    check(m.scrollHeight > m.innerHeight,
        `workspace: content is longer than the viewport, so the page must scroll (${m.scrollHeight} > ${m.innerHeight})`);

    // Each section of the required hierarchy must be in the layout.
    for (const [sel, label] of [
        ['#readiness', 'readiness banner'],
        ['#queue', 'incoming requests'],
        ['#drivers', 'park drivers'],
        ['#btn-arrivals', "who's here"],
    ]) {
        const el = await js(REACHABLE(sel));
        check(el.exists && el.rendered, `workspace: ${label} is rendered`);
    }

    /*
     * The regression that started this. `display: none` on every phone meant a
     * dispatcher could not end their shift at all — checked as "is it in the
     * layout", which a screenshot comparison would not have told us.
     */
    const endMobile = await js(REACHABLE('#btn-end-shift-mobile'));
    const endTop = await js(REACHABLE('#btn-end-shift'));
    const anyEnd = (endMobile.exists && endMobile.rendered) || (endTop.exists && endTop.rendered);
    check(anyEnd, `workspace: an End shift control is rendered (mobile=${endMobile.display}, topbar=${endTop.display})`);

    if (endMobile.rendered) {
        check(endMobile.height >= 44, `workspace: End shift is at least 44px tall (${endMobile.height}px)`);
    }

    // Scroll to the bottom and confirm End shift actually arrives on screen.
    await js('window.scrollTo(0, document.documentElement.scrollHeight)');
    await sleep(350);

    const after = await js(MEASURE);
    check(after.scrollY > 0, `workspace: the page scrolled (scrollY ${after.scrollY})`);

    const endAfter = await js(REACHABLE(endMobile.rendered ? '#btn-end-shift-mobile' : '#btn-end-shift'));
    check(endAfter.top < after.innerHeight && endAfter.bottom > 0,
        `workspace: End shift enters the viewport at the bottom (top ${endAfter.top}, viewport ${after.innerHeight})`);

    /*
     * Nothing fixed may sit on top of it. The toasts container is fixed at the
     * bottom by design, so this checks the button is not underneath it.
     */
    const covered = await js(`
    (() => {
        const el = document.querySelector('#btn-end-shift-mobile') || document.querySelector('#btn-end-shift');
        if (!el) return { covered: false };
        const r = el.getBoundingClientRect();
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        const hit = document.elementFromPoint(x, y);
        return { covered: !(hit === el || el.contains(hit)), by: hit ? (hit.id || hit.className) : null };
    })()`);
    check(!covered.covered, `workspace: End shift is not covered by another element${covered.by ? ` (topmost: ${covered.by})` : ''}`);

    await shot(send, `${vp.name}-workspace-bottom`);

    // Back to the top, as a dispatcher would after ending a look at the roster.
    await js('window.scrollTo(0, 0)');
    await sleep(250);
    const top = await js(MEASURE);
    check(top.scrollY === 0, 'workspace: the page can return to the top');

    await shot(send, `${vp.name}-workspace-top`);

    /*
     * A live refresh must not throw the dispatcher back to the top. The board
     * repaints every few seconds; losing scroll position each time would make
     * the roster unreadable on a phone.
     */
    await js('window.scrollTo(0, 300)');
    await sleep(200);
    const before = await js('window.scrollY');
    await js('render()');
    await sleep(300);
    const afterRender = await js('window.scrollY');
    check(Math.abs(afterRender - before) < 40,
        `workspace: a re-render preserves scroll position (${before} → ${afterRender})`);

    await js('window.scrollTo(0, 0)');
    await testSheet(js, vp, send);
}

/**
 * A modal must fit the viewport and scroll inside itself.
 *
 * The arrivals sheet is the tallest thing in the app — a whole roster with four
 * presence buttons per driver — and is the one place an internal scroll is
 * correct, because scrolling the board behind an open modal is disorienting.
 */
async function testSheet(js, vp, send) {
    await js(`(() => {
        ARRIVALS = Array.from({ length: 12 }, (_, i) => ({
            driverId: 'd' + i,
            firstName: 'Driver', lastName: 'Number ' + i,
            unitNumber: 'AB-' + i + '23-CD', vehiclePlate: 'AB-' + i + '23-CD',
            presenceState: i % 3 === 0 ? 'waiting' : 'offline',
            featurePhoneOnly: i % 4 === 0,
            problems: i % 2 === 0 ? [{ code: 'no_badge', message: 'No badge issued' }] : [],
        }));
        document.getElementById('arrivals').classList.remove('hidden');
        renderArrivals();
    })()`);
    await sleep(350);

    const m = await js(MEASURE);
    const sheet = await js(`
    (() => {
        const el = document.querySelector('#arrivals .sheet');
        if (!el) return { exists: false };
        const r = el.getBoundingClientRect();
        const list = document.querySelector('#arrivals-list');
        return {
            exists: true,
            height: Math.round(r.height),
            top: Math.round(r.top),
            bottom: Math.round(r.bottom),
            listScrolls: list ? list.scrollHeight > list.clientHeight + 1 : false,
            closeVisible: (() => {
                const b = document.querySelector('#arrivals-close');
                if (!b) return false;
                const br = b.getBoundingClientRect();
                return br.top >= 0 && br.bottom <= window.innerHeight + 1;
            })(),
        };
    })()`);

    check(sheet.exists, 'sheet: the arrivals modal renders');
    check(sheet.bottom <= m.innerHeight + 1,
        `sheet: fits inside the viewport (bottom ${sheet.bottom}, viewport ${m.innerHeight})`);
    check(sheet.listScrolls,
        'sheet: a long roster scrolls inside the sheet rather than growing the page');
    check(sheet.closeVisible,
        'sheet: the Done button stays reachable with a long roster');

    await shot(send, `${vp.name}-arrivals-sheet`);

    // Closing must return the board, not leave a stuck overlay.
    await js(`document.getElementById('arrivals').classList.add('hidden')`);
    await sleep(150);
    const closed = await js(REACHABLE('#arrivals'));
    check(!closed.rendered, 'sheet: closing returns the dispatcher to the board');
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
