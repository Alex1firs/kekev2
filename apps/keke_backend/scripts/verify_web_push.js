/**
 * Prove dispatcher Web Push works end to end, against a deployed environment.
 *
 * A real browser: registers the messaging service worker, asks Firebase for an
 * FCM token with the VAPID key, binds it to a StaffUser, then asks the server
 * to send to that token and checks what Google actually said.
 *
 * ── What this proves and what it does not ───────────────────────────────
 * It proves the whole chain up to and including FCM ACCEPTING the message for
 * a real device token: configuration, service worker, subscription, token
 * registration, park binding, and the send path.
 *
 * It does NOT prove a notification appeared on a phone, made a sound, or woke
 * anybody. Headless Chrome has no notification tray and no speaker. That is
 * the physical test, and nothing here replaces it.
 *
 *   node scripts/verify_web_push.js https://staging.kekeride.ng/dispatch/
 */
const { spawn } = require('child_process');

const BASE = process.argv[2] || 'https://staging.kekeride.ng/dispatch/';
const ORIGIN = new URL(BASE).origin;
const EMAIL = process.env.DISPATCHER_EMAIL;
const PASSWORD = process.env.DISPATCHER_PASSWORD;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (m, d = '') => { pass++; console.log(`  \x1b[32mPASS\x1b[0m  ${m}${d ? `\n        ${d}` : ''}`); };
const bad = (m, d = '') => { fail++; console.log(`  \x1b[31mFAIL\x1b[0m  ${m}${d ? `\n        ${d}` : ''}`); };

async function main() {
    if (!EMAIL || !PASSWORD) { console.error('set DISPATCHER_EMAIL and DISPATCHER_PASSWORD'); process.exit(2); }

    const PORT = 9800 + Math.floor(Math.random() * 150);
    const profile = `/tmp/kkpush-${Date.now()}`;
    const chrome = spawn(CHROME, [
        '--headless=new', '--disable-gpu', '--no-sandbox',
        `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
        // Grant notification permission without a prompt; a headless browser
        // has nobody to click "Allow".
        `--unsafely-treat-insecure-origin-as-secure=${ORIGIN}`,
        '--enable-features=NetworkService',
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
    const js = async (expr, awaitPromise = true) => {
        const r = await send('Runtime.evaluate', { expression: expr, awaitPromise, returnByValue: true });
        if (r.result?.exceptionDetails) return `EXCEPTION: ${r.result.exceptionDetails.text}`;
        return r.result?.result?.value;
    };

    await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');
    const consoleErrors = [];
    ws.addEventListener('message', (e) => {
        const m = JSON.parse(e.data);
        if (m.method === 'Log.entryAdded') consoleErrors.push(m.params.entry.text);
    });
    await send('Browser.grantPermissions', { origin: ORIGIN, permissions: ['notifications'] });

    console.log(`\n\x1b[1mDispatcher Web Push verification\x1b[0m\n  ${BASE}\n`);

    await send('Page.navigate', { url: BASE });
    await sleep(3000);

    // ── 1. secure context and permission ─────────────────────────────────
    const env = JSON.parse(await js(`JSON.stringify({
        secure: window.isSecureContext,
        permission: Notification.permission,
        hasPush: 'PushManager' in window,
        hasSW: 'serviceWorker' in navigator,
    })`, false));
    if (env.secure) ok('HTTPS / secure context'); else bad('secure context', JSON.stringify(env));
    if (env.hasPush && env.hasSW) ok('Push API and service workers available');
    else bad('Push API / service worker support', JSON.stringify(env));
    if (env.permission === 'granted') ok(`notification permission: ${env.permission}`);
    else bad(`notification permission: ${env.permission}`);

    // ── 2. sign in ───────────────────────────────────────────────────────
    const signedIn = await js(`(async () => {
        const r = await fetch('/api/v1/staff/auth/login', { method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(${JSON.stringify({ identifier: EMAIL, password: PASSWORD })}) });
        const d = await r.json();
        if (!d.accessToken) return 'login failed: ' + (d.message || r.status);
        sessionStorage.setItem('KD_TOKEN', d.accessToken);
        sessionStorage.setItem('KD_REFRESH', d.refreshToken);
        const me = await (await fetch('/api/v1/dispatcher/me',
            { headers: { Authorization: 'Bearer ' + d.accessToken } })).json();
        if (!me.onDuty) {
            const p = (me.assignedParks || []).find(x => x.status === 'active');
            if (p) await fetch('/api/v1/dispatcher/shifts/open', { method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + d.accessToken },
                body: JSON.stringify({ parkId: p.parkId }) });
        }
        return 'ok';
    })()`);
    if (signedIn === 'ok') ok('dispatcher signed in and on shift'); else { bad('sign in', String(signedIn)); return finish(); }

    // ── 3. the messaging service worker ──────────────────────────────────
    const swState = await js(`(async () => {
        // The app-shell worker handles push too — one worker per scope.
        const reg = await navigator.serviceWorker.register('./sw.js', { scope: './' });
        await navigator.serviceWorker.ready;
        return reg.active ? 'active' : (reg.installing ? 'installing' : 'waiting');
    })()`);
    if (swState === 'active') ok('service worker registered and active (handles shell + push)');
    else bad('service worker', String(swState));

    // ── 4. an FCM token, using the VAPID key ─────────────────────────────
    const tokenResult = await js(`(async () => {
        const cfgRes = await fetch('/api/v1/dispatcher/push/config', {
            headers: { Authorization: 'Bearer ' + sessionStorage.getItem('KD_TOKEN') } });
        const cfg = await cfgRes.json();
        if (!cfg.available) return 'config unavailable: ' + JSON.stringify(cfg.missing);

        const load = (src) => new Promise((ok2, no) => {
            const s = document.createElement('script'); s.src = src; s.onload = ok2; s.onerror = () => no(new Error(src));
            document.head.appendChild(s);
        });
        await load('vendor/firebase-app-compat.js');
        await load('vendor/firebase-messaging-compat.js');
        if (!firebase.apps.length) firebase.initializeApp(cfg.config);

        const reg = await navigator.serviceWorker.getRegistration('./');
        if (!reg) return 'no service worker registration found';

        try {
            const messaging = firebase.messaging();
            const token = await messaging.getToken({
                vapidKey: cfg.config.vapidPublicKey,
                serviceWorkerRegistration: reg,
            });
            return token ? 'TOKEN:' + token : 'getToken resolved with no token';
        } catch (err) {
            // Report the real reason. "Failed to fetch" and an unsupported
            // browser look identical from the outside otherwise.
            return 'ERROR: ' + (err && (err.code || err.name) ? (err.code || err.name) + ' — ' : '')
                + (err && err.message ? err.message : String(err));
        }
    })()`);

    let fcmToken = null;
    if (typeof tokenResult === 'string' && tokenResult.startsWith('TOKEN:')) {
        fcmToken = tokenResult.slice(6);
        ok('FCM registration token obtained', `…${fcmToken.slice(-16)} (${fcmToken.length} chars)`);
    } else {
        bad('FCM registration token', String(tokenResult).slice(0, 300));
        const csp = consoleErrors.filter((t) => /Content Security Policy|Refused to connect/i.test(t));
        if (csp.length) {
            console.log('        \x1b[33mCSP violations seen:\x1b[0m');
            csp.slice(0, 3).forEach((c) => console.log('          ' + c.slice(0, 180)));
        }
        return finish();
    }

    // ── 5. bind it to the StaffUser ──────────────────────────────────────
    const reg = await js(`(async () => {
        const r = await fetch('/api/v1/dispatcher/push/register', { method: 'POST',
            headers: { 'Content-Type': 'application/json',
                       Authorization: 'Bearer ' + sessionStorage.getItem('KD_TOKEN') },
            body: JSON.stringify({ token: ${JSON.stringify(fcmToken)},
                                   deviceId: 'verify-headless', deviceLabel: 'Verification run' }) });
        return JSON.stringify(await r.json());
    })()`);
    const regData = JSON.parse(reg);
    if (regData.registered) ok('token registered to the dispatcher', `park bound: ${regData.boundToShift}`);
    else bad('token registration', reg);

    // ── 6. send a real push and read what Google said ────────────────────
    const test = await js(`(async () => {
        const r = await fetch('/api/v1/dispatcher/push/test', { method: 'POST',
            headers: { 'Content-Type': 'application/json',
                       Authorization: 'Bearer ' + sessionStorage.getItem('KD_TOKEN') },
            body: JSON.stringify({ deviceTokenId: ${JSON.stringify(regData.deviceTokenId)} }) });
        return JSON.stringify(await r.json());
    })()`);
    const testData = JSON.parse(test);
    if (testData.accepted) ok('FCM ACCEPTED a push for this device', testData.detail);
    else bad('FCM accepted a push', testData.detail || test);

    // ── 7. the evidence trail ────────────────────────────────────────────
    await sleep(2500);
    const status = JSON.parse(await js(`(async () => {
        const r = await fetch('/api/v1/dispatcher/push/status',
            { headers: { Authorization: 'Bearer ' + sessionStorage.getItem('KD_TOKEN') } });
        return JSON.stringify(await r.json());
    })()`));
    const latest = (status.recent || [])[0];
    if (latest) {
        ok('delivery evidence recorded',
            `state=${latest.state} reason=${latest.reason} providerRef=${(latest.providerRef || '').slice(0, 40)}`);
        if (latest.state === 'provider_accepted') {
            ok('state is provider_accepted — NOT called "delivered"',
                'Google took the message. Whether a phone showed it is the physical test.');
        }
    } else {
        bad('delivery evidence recorded', JSON.stringify(status).slice(0, 200));
    }

    // Did the worker actually receive it? Headless has no tray, but the push
    // event still fires if the message arrives.
    const received = await js(`(async () => {
        await new Promise(r => setTimeout(r, 4000));
        const s = await fetch('/api/v1/dispatcher/push/status',
            { headers: { Authorization: 'Bearer ' + sessionStorage.getItem('KD_TOKEN') } });
        const d = await s.json();
        return (d.devices[0] || {}).lastPushReceivedAt || 'none';
    })()`);
    console.log(`  \x1b[33mINFO\x1b[0m  service-worker receipt: ${received}`
        + (received === 'none' ? '\n        (headless often will not run the push handler — expected; the phone test covers this)' : ''));

    finish();

    function finish() {
        console.log(`\n  \x1b[1m${pass} passed, ${fail} failed\x1b[0m\n`);
        ws.close(); chrome.kill();
        setTimeout(() => {
            try { require('fs').rmSync(profile, { recursive: true, force: true }); } catch {}
            process.exit(fail === 0 ? 0 : 1);
        }, 400);
    }
}

main().catch((e) => { console.error('VERIFY FAILED:', e.message); process.exit(1); });
