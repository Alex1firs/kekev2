/**
 * PWA audit for KekeRide Park Dispatch, driven over the DevTools Protocol.
 *
 * Checks the things that actually determine whether an Android tablet will
 * offer "Add to Home Screen", plus service-worker activation and offline
 * behaviour — none of which can be verified by reading the files.
 */
const { spawn } = require('child_process');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
// Overridable so the same audit can be run against staging over real HTTPS,
// which is the only environment the launch gate accepts.
const BASE = process.argv[2] || process.env.PWA_AUDIT_URL || 'http://127.0.0.1:4100/dispatch/';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (m) => { console.log(`  PASS  ${m}`); pass++; };
const bad = (m) => { console.log(`  FAIL  ${m}`); fail++; };

async function main() {
    const PORT = 9700 + Math.floor(Math.random() * 200);
    const profile = `/tmp/kkpwa-${Date.now()}`;
    const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
        `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
        // 127.0.0.1 is already a secure context; stated explicitly so the
        // audit matches what an https:// deployment will do.
        // Only needed for a plain-http origin. Harmless (and ignored) for
        // https, where the origin is already a secure context.
        `--unsafely-treat-insecure-origin-as-secure=${new URL(BASE).origin}`,
        'about:blank'], { stdio: 'ignore' });

    let target;
    for (let i = 0; i < 60; i++) {
        await sleep(250);
        try {
            const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
            target = l.find(t => t.type === 'page'); if (target) break;
        } catch {}
    }
    if (!target) throw new Error('chrome did not start');

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise(r => ws.addEventListener('open', r));
    let id = 0; const pending = new Map();
    ws.addEventListener('message', (e) => {
        const m = JSON.parse(e.data);
        if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    });
    const send = (method, params = {}) => new Promise(res => {
        const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params }));
    });
    const evalJs = async (expression, awaitPromise = true) => {
        const r = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
        if (r.result?.exceptionDetails) return { error: r.result.exceptionDetails.text };
        return r.result?.result?.value;
    };

    await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 412, height: 915, deviceScaleFactor: 2, mobile: true });

    // ── manifest ─────────────────────────────────────────────────────────
    await send('Page.navigate', { url: BASE });
    await sleep(2500);

    const manifest = await evalJs(`fetch('manifest.webmanifest').then(r=>r.json())`);
    if (manifest && manifest.name === 'KekeRide Park Dispatch') ok(`manifest name: ${manifest.name}`); else bad(`manifest name wrong: ${JSON.stringify(manifest).slice(0,120)}`);
    if (manifest?.short_name) ok(`short_name: ${manifest.short_name}`); else bad('short_name missing');
    if (manifest?.display === 'standalone') ok('display: standalone'); else bad(`display is ${manifest?.display}`);
    if (manifest?.start_url) ok(`start_url: ${manifest.start_url}`); else bad('start_url missing');
    if (manifest?.theme_color) ok(`theme_color: ${manifest.theme_color}`); else bad('theme_color missing');

    const sizes = (manifest?.icons || []).map(i => i.sizes);
    if (sizes.includes('192x192') && sizes.includes('512x512')) ok('icons 192 + 512 declared'); else bad(`icons: ${sizes.join(',')}`);
    const maskable = (manifest?.icons || []).some(i => (i.purpose || '').includes('maskable'));
    if (maskable) ok('maskable icon declared'); else bad('no maskable icon');

    // Icons must actually load and be the size they claim.
    for (const icon of manifest?.icons || []) {
        const dim = await evalJs(`new Promise(res => { const i = new Image();
            i.onload = () => res(i.naturalWidth + 'x' + i.naturalHeight);
            i.onerror = () => res('ERROR'); i.src = '${icon.src}'; })`);
        if (dim === icon.sizes) ok(`${icon.src} loads at ${dim}`); else bad(`${icon.src} is ${dim}, declared ${icon.sizes}`);
    }

    // ── service worker ───────────────────────────────────────────────────
    const swState = await evalJs(`navigator.serviceWorker.getRegistration().then(r =>
        r ? (r.active ? 'active' : r.installing ? 'installing' : r.waiting ? 'waiting' : 'registered') : 'none')`);
    if (swState === 'active') ok('service worker active'); else bad(`service worker state: ${swState}`);

    const controlled = await evalJs(`!!navigator.serviceWorker.controller`);
    if (controlled) ok('page is controlled by the worker'); else bad('page not controlled (may need one reload)');

    const cached = await evalJs(`caches.keys().then(k => k.join(','))`);
    if (String(cached).includes('kd-shell')) ok(`shell cached: ${cached}`); else bad(`no shell cache: ${cached}`);

    // The rule that matters: API responses must never be cached.
    const apiCached = await evalJs(`(async () => {
        const keys = await caches.keys();
        let n = 0;
        for (const k of keys) {
            const c = await caches.open(k);
            n += (await c.keys()).filter(r => r.url.includes('/api/') || r.url.includes('/socket.io/')).length;
        }
        return n;
    })()`);
    if (apiCached === 0) ok('no /api/ response cached'); else bad(`${apiCached} API responses cached`);

    // ── offline ──────────────────────────────────────────────────────────
    // Sign in first: the stale-board warning is about a board that exists.
    // On the login screen there is nothing to be stale, and it correctly
    // stays hidden.
    const signedIn = await evalJs(`(async () => {
        const r = await fetch('/api/v1/staff/auth/login', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(${JSON.stringify({
                identifier: process.env.DISPATCHER_EMAIL || 'chidi@kekeride.test',
                password: process.env.DISPATCHER_PASSWORD || 'KekeDemo-Pass99',
            })}) });
        const d = await r.json();
        if (!d.accessToken) return 'login failed: ' + (d.message || r.status);
        sessionStorage.setItem('KD_TOKEN', d.accessToken);
        sessionStorage.setItem('KD_REFRESH', d.refreshToken);
        sessionStorage.setItem('KD_SOUND', 'off');
        return 'ok';
    })()`);
    if (signedIn === 'ok') ok('signed in for the offline check'); else bad(`could not sign in: ${signedIn}`);

    /*
     * Open a shift if there is not one already. Without this the audit depends
     * on whatever ran before it — the acceptance run closes the shift at its
     * last scenario, and this would then fail for a reason that has nothing to
     * do with the PWA.
     */
    const shift = await evalJs(`(async () => {
        const t = sessionStorage.getItem('KD_TOKEN');
        const me = await (await fetch('/api/v1/dispatcher/me', { headers: { Authorization: 'Bearer ' + t } })).json();
        if (me.onDuty) return 'already';
        const park = (me.assignedParks || []).find(p => p.status === 'active');
        if (!park) return 'no park';
        const r = await fetch('/api/v1/dispatcher/shifts/open', {
            method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t },
            body: JSON.stringify({ parkId: park.parkId }) });
        return r.ok ? 'opened' : 'failed ' + r.status;
    })()`);
    if (/already|opened/.test(shift)) ok(`shift ready (${shift})`); else bad(`could not open a shift: ${shift}`);

    await send('Page.navigate', { url: BASE });
    await sleep(5000);

    const onBoard = await evalJs(`!document.getElementById('workspace').classList.contains('hidden')`, false);
    if (onBoard) ok('workspace loaded while online'); else bad('workspace did not load');

    // Now cut the network. navigator.onLine does NOT flip under CDP emulation
    // (nor reliably on a real phone attached to a tower with no data), which is
    // exactly why the app judges staleness by failed requests instead.
    await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
    await sleep(18000);   // two failed 7s polls, plus the staleness threshold

    const netState = await evalJs(`JSON.stringify({
        onLine: navigator.onLine,
        failed: (typeof S !== 'undefined') ? S.failedRefreshes : null,
        barHidden: document.getElementById('offline-bar').classList.contains('hidden'),
        text: document.getElementById('offline-bar').textContent.replace(/\s+/g, ' ').trim(),
    })`, false);
    console.log('       network state:', netState);
    const st = JSON.parse(netState);
    if (st.barHidden === false) ok(`stale-board warning shown despite navigator.onLine=${st.onLine}`);
    else bad(`stale-board warning did NOT show (${netState})`);

    // And the shell still serves from cache with the network down.
    await send('Page.navigate', { url: BASE });
    await sleep(2500);
    const shellOffline = await evalJs(`!!document.getElementById('login') || !!document.getElementById('workspace')`, false);
    if (shellOffline) ok('app shell still served offline'); else bad('offline shell failed');

    await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });

    console.log(`\n  ${pass} passed, ${fail} failed`);
    ws.close(); chrome.kill(); await sleep(300);
    try { require('fs').rmSync(profile, { recursive: true, force: true }); } catch {}
    process.exit(fail === 0 ? 0 : 1);
}

main().catch(e => { console.error('AUDIT FAILED:', e.message); process.exit(1); });
