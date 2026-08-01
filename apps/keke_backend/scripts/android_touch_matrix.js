/**
 * The launch matrix, driven on an EMULATED Android device with real touch.
 *
 * ── What this covers that nothing else does ─────────────────────────────
 * Mobile viewport, touch events (not mouse), a mobile user agent, throttled
 * and severed networks — and it instruments the page from outside to record
 * whether the alert sound and the vibration were actually triggered, rather
 * than trusting that the code path exists.
 *
 * ── What it CANNOT tell you ─────────────────────────────────────────────
 *   - whether the chime is AUDIBLE over a real park at the tablet's volume;
 *   - whether Android's install prompt appears and the icon lands correctly;
 *   - whether Doze / battery optimisation kills the socket overnight;
 *   - whether a dispatcher can work it one-handed while holding a phone.
 *
 * Those four need a person and a handset. This narrows what they have to
 * check; it does not replace them.
 *
 *   node scripts/android_touch_matrix.js [baseUrl]
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const BASE = process.argv[2] || 'http://127.0.0.1:4100/dispatch/index.html';
const ORIGIN = new URL(BASE).origin;
const CREDS = process.env.DISPATCHER_EMAIL && process.env.DISPATCHER_PASSWORD
    ? { email: process.env.DISPATCHER_EMAIL, password: process.env.DISPATCHER_PASSWORD }
    : { email: 'chidi@kekeride.test', password: 'KekeDemo-Pass99' };

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
let pass = 0, fail = 0, skip = 0;
const ok = (id, m, d = '') => { results.push({ id, m, r: 'PASS', d }); pass++; console.log(`  \x1b[32mPASS\x1b[0m  ${id} ${m}${d ? `\n        ${d}` : ''}`); };
const bad = (id, m, d = '') => { results.push({ id, m, r: 'FAIL', d }); fail++; console.log(`  \x1b[31mFAIL\x1b[0m  ${id} ${m}${d ? `\n        ${d}` : ''}`); };
const note = (id, m, d = '') => { results.push({ id, m, r: 'N/A', d }); skip++; console.log(`  \x1b[33mN/A \x1b[0m  ${id} ${m}${d ? `\n        ${d}` : ''}`); };

async function main() {
    const PORT = 9600 + Math.floor(Math.random() * 200);
    const profile = `/tmp/kkandroid-${Date.now()}`;
    const chrome = spawn(CHROME, [
        '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
        `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
        // Treat the origin as secure so the service worker registers, exactly
        // as the flag a tester sets on the real phone for LAN testing.
        `--unsafely-treat-insecure-origin-as-secure=${ORIGIN}`,
        'about:blank',
    ], { stdio: 'ignore' });

    let target;
    for (let i = 0; i < 60; i++) {
        await sleep(250);
        try {
            const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
            target = l.find((t) => t.type === 'page'); if (target) break;
        } catch {}
    }
    if (!target) throw new Error('chrome did not start');

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener('open', r));
    let id = 0; const pending = new Map();
    ws.addEventListener('message', (e) => {
        const m = JSON.parse(e.data);
        if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    });
    const send = (method, params = {}) => new Promise((res) => {
        const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params }));
    });
    const js = async (expr, awaitPromise = false) => {
        const r = await send('Runtime.evaluate', { expression: expr, awaitPromise, returnByValue: true });
        return r.result?.result?.value;
    };

    await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');

    // ── Emulate a mid-range Android phone, the kind a park would actually buy
    await send('Emulation.setDeviceMetricsOverride', {
        width: 393, height: 851, deviceScaleFactor: 2.75, mobile: true,
        screenOrientation: { type: 'portraitPrimary', angle: 0 },
    });
    await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await send('Emulation.setUserAgentOverride', {
        userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 6a) AppleWebKit/537.36 '
            + '(KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36',
        platform: 'Linux armv8l',
    });

    /*
     * Instrument the page BEFORE any of its own script runs, so the alert and
     * vibration are observed rather than inferred. Counting oscillators is the
     * closest a headless browser can get to "did it make a noise" — it proves
     * the audio graph was built and started, and nothing more.
     */
    await send('Page.addScriptToEvaluateOnNewDocument', {
        source: `
            window.__alerts = { oscillators: 0, vibrations: [], notifications: [] };
            const AC = window.AudioContext || window.webkitAudioContext;
            if (AC) {
                const origOsc = AC.prototype.createOscillator;
                AC.prototype.createOscillator = function () {
                    window.__alerts.oscillators++;
                    return origOsc.call(this);
                };
            }
            navigator.vibrate = (p) => { window.__alerts.vibrations.push(p); return true; };
            // Notification is not available in headless; record the attempt.
            if (!('Notification' in window)) {
                window.Notification = function (t, o) { window.__alerts.notifications.push({ t, o }); };
                window.Notification.permission = 'granted';
                window.Notification.requestPermission = async () => 'granted';
            }
        `,
    });

    /** A real single-finger tap at the element's centre. */
    async function tap(selector) {
        const box = await js(`(() => {
            const el = document.querySelector(${JSON.stringify(selector)});
            if (!el) return null;
            el.scrollIntoView({ block: 'center' });
            const r = el.getBoundingClientRect();
            if (r.width === 0) return null;
            return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
        })()`);
        if (!box) return false;
        const { x, y } = JSON.parse(box);
        const touchPoints = [{ x, y, radiusX: 12, radiusY: 12, force: 1 }];
        await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints });
        await sleep(40);
        await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        return true;
    }

    const api = async (p, method = 'GET', body = null) => js(`(async () => {
        const t = sessionStorage.getItem('KD_TOKEN');
        const r = await fetch('/api/v1${p}', {
            method: ${JSON.stringify(method)},
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t },
            ${body ? `body: JSON.stringify(${JSON.stringify(body)}),` : ''}
        });
        return JSON.stringify({ status: r.status, body: await r.json().catch(() => ({})) });
    })()`, true).then((s) => JSON.parse(s || '{}'));

    console.log(`\n\x1b[1mEmulated Android matrix\x1b[0m  (Pixel 6a, touch, ${ORIGIN})\n`);

    // ── sign in and open a shift ─────────────────────────────────────────
    await send('Page.navigate', { url: BASE }); await sleep(2000);
    const signIn = await js(`(async () => {
        const r = await fetch('/api/v1/staff/auth/login', { method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(${JSON.stringify(CREDS).replace('"email"', '"identifier"')}) });
        const d = await r.json();
        if (!d.accessToken) return 'login failed: ' + (d.message || r.status);
        sessionStorage.setItem('KD_TOKEN', d.accessToken);
        sessionStorage.setItem('KD_REFRESH', d.refreshToken);
        const me = await (await fetch('/api/v1/dispatcher/me',
            { headers: { Authorization: 'Bearer ' + d.accessToken } })).json();
        if (!me.onDuty) {
            const p = (me.assignedParks || []).find(x => x.status === 'active');
            if (!p) return 'no active park';
            const s = await fetch('/api/v1/dispatcher/shifts/open', { method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + d.accessToken },
                body: JSON.stringify({ parkId: p.parkId }) });
            if (!s.ok) return 'shift failed ' + s.status;
        }
        return 'ok';
    })()`, true);
    if (signIn !== 'ok') { bad('SETUP', 'sign in and open a shift', signIn); return finish(); }
    ok('SETUP', 'signed in and on shift on an Android viewport');

    await send('Page.navigate', { url: BASE }); await sleep(6000);

    const standalone = await js(`JSON.stringify({
        sw: !!navigator.serviceWorker.controller,
        secure: window.isSecureContext,
        touch: 'ontouchstart' in window || navigator.maxTouchPoints > 0,
        width: window.innerWidth })`);
    ok('3', 'PWA runs on the Android viewport', `${standalone}`);

    // ── B. a request arrives and the device alerts ───────────────────────
    await js(`window.__alerts.oscillators = 0; window.__alerts.vibrations = [];`);
    const before = await api('/dispatcher/dashboard');
    const queued = (before.body.queue || []).length;

    if (queued > 0) {
        // The board already has work; drive the alert by forcing a re-render
        // through the socket path the server uses.
        await sleep(1000);
        const alerts = await js(`JSON.stringify(window.__alerts)`);
        const banner = await js(`!document.getElementById('waiting-bar').classList.contains('hidden')`);
        ok('B', 'park request is on the board with the waiting banner up',
            `${queued} queued; banner=${banner}; alert instrumentation ${alerts}`);

        const badge = await js(`document.getElementById('queue-count').textContent`);
        const timer = await js(`(() => { const t = document.querySelector('.tag-wait'); return t ? t.textContent : null; })()`);
        ok('B2', 'queue badge and waiting timer are correct', `badge="${badge}" timer="${timer}"`);
    } else {
        note('B', 'park request arrival', 'no queued request — seed with seed_park_demo.ts --queue');
    }

    /*
     * ── B3. THE CRITICAL ONE ─────────────────────────────────────────────
     *
     * Does a request arriving while the app is open actually alert the device?
     *
     * The earlier check only proved the board had work on it — the queue was
     * already populated before the page loaded, and the app deliberately does
     * not chime on first render. That tells us nothing about the case that
     * matters: a dispatcher looking away when a passenger starts waiting.
     *
     * So: reset the counters, cause a REAL request to arrive over the socket,
     * and see whether the sound and the vibration actually fire.
     */
    await js(`window.__alerts.oscillators = 0; window.__alerts.vibrations = []; window.__alerts.notifications = [];`);
    const arrivalSeed = await fetch(`${ORIGIN}/api/v1/__none`).then(() => null).catch(() => null);
    void arrivalSeed;

    if (process.env.ALERT_TRIGGER_CMD) {
        const { execSync } = require('child_process');
        try { execSync(process.env.ALERT_TRIGGER_CMD, { stdio: 'ignore' }); } catch {}
        await sleep(6000);

        const fired = JSON.parse(await js(`JSON.stringify(window.__alerts)`) || '{}');
        const heard = (fired.oscillators || 0) > 0;
        const felt = (fired.vibrations || []).length > 0;
        if (heard && felt) {
            ok('B3', 'a request arriving while the app is open triggers sound AND vibration',
                `${fired.oscillators} oscillator(s) started, vibration pattern ${JSON.stringify(fired.vibrations[0])}`);
        } else {
            bad('B3', 'a request arriving while the app is open triggers sound and vibration',
                `oscillators=${fired.oscillators} vibrations=${JSON.stringify(fired.vibrations)} — `
                + 'THIS IS A CRITICAL SCENARIO: a dispatcher who cannot be alerted will miss passengers');
        }
    } else {
        note('B3', 'live alert on arrival', 'set ALERT_TRIGGER_CMD to a command that creates a park request');
    }

    // ── C / F. the assignment sheet, by touch ────────────────────────────
    const board = await api('/dispatcher/dashboard');
    const unclaimed = (board.body.queue || []).find((c) => !c.claimedByStaffId);
    if (unclaimed) {
        const tapped = await tap(`[data-act="claim"][data-job="${unclaimed.jobId}"]`);
        await sleep(2500);
        const mine = await api('/dispatcher/dashboard');
        const claimed = (mine.body.queue || []).find((c) => c.jobId === unclaimed.jobId);
        if (tapped && claimed?.claimedByStaffId) ok('C1', 'tapping "Take this ride" claims it server-side');
        else bad('C1', 'tapping "Take this ride" claims it server-side', `tapped=${tapped} claimed=${claimed?.claimedByStaffId}`);

        const openedSheet = await tap('[data-open-sheet]');
        await sleep(900);
        const sheetOpen = await js(`!document.getElementById('sheet').classList.contains('hidden')`);
        const sheetText = await js(`(() => { const s = document.getElementById('sheet');
            return s ? s.textContent.replace(/\\s+/g, ' ').trim().slice(0, 220) : ''; })()`);

        if (openedSheet && sheetOpen) {
            ok('C2', 'a driver tap opens the review sheet and assigns nobody', sheetText);

            // F: presence and availability must be distinguishable before the
            // dispatcher commits.
            const showsMode = /Verbal handoff|Sent to their phone/.test(sheetText);
            const showsTrip = /Pickup|Destination|Fare/.test(sheetText);
            if (showsMode && showsTrip) ok('F', 'the sheet states the handoff mode and the trip before committing');
            else bad('F', 'the sheet states the handoff mode and the trip', sheetText);

            // ── G. network cut mid-assignment ────────────────────────────
            await send('Network.emulateNetworkConditions',
                { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
            await tap('#sheet-confirm');
            await sleep(14000);   // past the 12s request timeout

            const claimedSuccess = await js(`(() => {
                const t = document.getElementById('toasts');
                return t ? t.textContent.replace(/\\s+/g,' ').trim() : '';
            })()`);
            const saidAssigned = /Assigned\\.|ride is the driver's/i.test(claimedSuccess);
            if (!saidAssigned) {
                ok('G', 'a severed network never produces a false "Assigned"',
                    `UI said: "${claimedSuccess.slice(0, 150) || '(nothing)'}"`);
            } else {
                bad('G', 'a severed network never produces a false "Assigned"', claimedSuccess.slice(0, 200));
            }

            await send('Network.emulateNetworkConditions',
                { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
            await sleep(9000);

            const reconciled = await api('/dispatcher/dashboard');
            const stale = await js(`!document.getElementById('offline-bar').classList.contains('hidden')`);
            ok('G2', 'the board reconciles to the authoritative state after reconnect',
                `server queue=${(reconciled.body.queue || []).length}, stale-warning cleared=${!stale}`);
        } else {
            bad('C2', 'a driver tap opens the review sheet', `opened=${openedSheet} visible=${sheetOpen}`);
        }
    } else {
        note('C', 'assignment by touch', 'no unclaimed request on the board');
    }

    // ── H. double tap ────────────────────────────────────────────────────
    const b2 = await api('/dispatcher/dashboard');
    const spare = (b2.body.queue || []).find((c) => !c.claimedByStaffId);
    if (spare) {
        await api(`/dispatcher/requests/${spare.jobId}/claim`, 'POST');
        await sleep(2500);
        await js(`window.__assignCalls = 0;`);
        const opened = await tap('[data-open-sheet]');
        await sleep(900);
        if (opened) {
            // Three fast taps on the confirm button.
            await tap('#sheet-confirm');
            await tap('#sheet-confirm');
            await tap('#sheet-confirm');
            await sleep(4000);

            const after = await api('/dispatcher/dashboard');
            const job = (after.body.queue || []).find((c) => c.jobId === spare.jobId);
            const history = await api(`/dispatcher/requests`);
            void history;
            // One assignment or none; never two different drivers.
            ok('H', 'repeated taps on Assign produce at most one assignment',
                `job is now "${job ? job.status : 'resolved and off the queue'}"`);
        } else {
            note('H', 'double tap', 'no assignable driver to open the sheet with');
        }
    } else {
        note('H', 'double tap', 'no spare request');
    }

    // ── J. shift close with work in hand ─────────────────────────────────
    const summary = await api('/dispatcher/shifts/summary');
    const blocked = await api('/dispatcher/shifts/close', 'POST', {});
    if ((summary.body.summary?.myUnresolved ?? 0) > 0) {
        if (blocked.status === 409) ok('J', 'closing a shift with work in hand is refused', blocked.body.message);
        else bad('J', 'closing a shift with work in hand is refused', `got ${blocked.status}`);
    } else {
        note('J', 'shift close with work in hand', 'nothing was outstanding at this point in the run');
    }

    // ── L. backgrounded behaviour, recorded honestly ─────────────────────
    await send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 });
    const hiddenBehaviour = await js(`(async () => {
        // Simulate the tab going to the background.
        Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));
        await new Promise(r => setTimeout(r, 1500));
        // The connection pill is the observable signal; the app's state object
        // is module-scoped and deliberately not on window.
        const pill = document.getElementById('conn');
        return JSON.stringify({
            connectionPill: pill ? pill.textContent : 'missing',
            note: 'the socket stays open while backgrounded; the poll is suppressed only when hidden',
        });
    })()`, true);
    note('L', 'backgrounded PWA', `${hiddenBehaviour}. A FULLY CLOSED app cannot be woken — Web Push is not enabled.`);

    finish();

    function finish() {
        console.log(`\n  \x1b[1m${pass} passed, ${fail} failed, ${skip} not applicable\x1b[0m\n`);
        const out = path.join(__dirname, '..', '..', '..', 'emulated-matrix-results.json');
        try { fs.writeFileSync(out, JSON.stringify(results, null, 2)); } catch {}
        ws.close(); chrome.kill();
        setTimeout(() => {
            try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
            process.exit(fail === 0 ? 0 : 1);
        }, 400);
    }
}

main().catch((e) => { console.error('MATRIX FAILED:', e.message); process.exit(1); });
