/**
 * Drive the dispatcher UI by CLICKING, not by calling its functions.
 *
 * This exists because the CSP blocks inline event handlers and nothing caught
 * it: every earlier check either called the API directly or invoked a JS
 * function by name. The only way to know a button works is to dispatch a real
 * mouse event at its coordinates and watch what the server receives.
 */
const { spawn } = require('child_process');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
// Overridable so the same clicks can be driven against staging over HTTPS.
const BASE = process.argv[2] || 'http://127.0.0.1:4100/dispatch/index.html';

let pass = 0, fail = 0;
const ok = (m) => { console.log(`  PASS  ${m}`); pass++; };
const bad = (m) => { console.log(`  FAIL  ${m}`); fail++; };

async function main() {
    const PORT = 9500 + Math.floor(Math.random() * 300);
    const profile = `/tmp/kkui-${Date.now()}`;
    const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
        `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });

    let t;
    for (let i = 0; i < 60; i++) {
        await sleep(250);
        try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); t = l.find(x => x.type === 'page'); if (t) break; } catch {}
    }
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise(r => ws.addEventListener('open', r));
    let id = 0; const p = new Map(); const cspViolations = [];
    ws.addEventListener('message', (e) => {
        const m = JSON.parse(e.data);
        if (m.id && p.has(m.id)) { p.get(m.id)(m); p.delete(m.id); }
        if (m.method === 'Log.entryAdded' && /Content Security Policy/i.test(m.params.entry.text || '')) {
            cspViolations.push(m.params.entry.text);
        }
    });
    const send = (me, pa = {}) => new Promise(res => { const i = ++id; p.set(i, res); ws.send(JSON.stringify({ id: i, method: me, params: pa })); });
    const js = async (expr, awaitPromise = false) => {
        const r = await send('Runtime.evaluate', { expression: expr, awaitPromise, returnByValue: true });
        return r.result?.result?.value;
    };

    /** A real mouse click at the element's centre — not element.click(). */
    async function clickSelector(selector) {
        const box = await js(`(() => { const el = document.querySelector(${JSON.stringify(selector)});
            if (!el) return null; const r = el.getBoundingClientRect();
            el.scrollIntoView({block:'center'});
            const r2 = el.getBoundingClientRect();
            return JSON.stringify({x: r2.left + r2.width/2, y: r2.top + r2.height/2}); })()`);
        if (!box) return false;
        const { x, y } = JSON.parse(box);
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
        return true;
    }

    await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

    await send('Page.navigate', { url: BASE }); await sleep(2000);
    await js(`(async()=>{const r=await fetch('/api/v1/staff/auth/login',{method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify(${JSON.stringify({
            identifier: process.env.DISPATCHER_EMAIL || 'chidi@kekeride.test',
            password: process.env.DISPATCHER_PASSWORD || 'KekeDemo-Pass99',
        })})});
        const d=await r.json(); sessionStorage.setItem('KD_TOKEN',d.accessToken);
        sessionStorage.setItem('KD_REFRESH',d.refreshToken); sessionStorage.setItem('KD_SOUND','off');})()`, true);
    // Open a shift if this dispatcher is not already on one, so the script is
    // self-sufficient and can be re-run without hand-setup.
    const shiftState = await js(`(async () => {
        const t = sessionStorage.getItem('KD_TOKEN');
        const me = await (await fetch('/api/v1/dispatcher/me', { headers: { Authorization: 'Bearer ' + t } })).json();
        if (me.onDuty) return 'already';
        const park = (me.assignedParks || []).find(p => p.status === 'active');
        if (!park) return 'no park';
        const r = await fetch('/api/v1/dispatcher/shifts/open', {
            method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t },
            body: JSON.stringify({ parkId: park.parkId }) });
        return r.ok ? 'opened' : 'failed ' + r.status;
    })()`, true);
    if (/already|opened/.test(shiftState)) ok(`shift ready (${shiftState})`); else bad(`could not open a shift: ${shiftState}`);

    await send('Page.navigate', { url: BASE }); await sleep(6000);

    const ready = await js(`!document.getElementById('workspace').classList.contains('hidden')`);
    if (ready) ok('workspace loaded'); else { bad('workspace did not load'); return finish(); }

    // ── 1. Selecting a card by clicking it ───────────────────────────────
    const before = await js(`S.selectedJobId`);
    const jobs = await js(`JSON.stringify([...document.querySelectorAll('.card[data-job]')].map(c=>c.dataset.job))`);
    const jobIds = JSON.parse(jobs || '[]');
    if (jobIds.length >= 2) {
        const other = jobIds.find((j) => j !== before) || jobIds[1];
        await clickSelector(`.card[data-job="${other}"]`);
        await sleep(600);
        const after = await js(`S.selectedJobId`);
        if (after === other) ok('clicking a queue card selects it'); else bad(`card click did nothing (still ${after})`);
    } else {
        console.log('  SKIP  fewer than two queue cards to switch between');
    }

    // ── 2. "Take this ride" actually claims, server-side ─────────────────
    const claimable = await js(`(() => { const b = document.querySelector('[data-act="claim"]');
        return b ? b.dataset.job : null; })()`);
    if (claimable) {
        await clickSelector(`[data-act="claim"][data-job="${claimable}"]`);
        await sleep(2500);
        const mine = await js(`(async () => {
            const t = sessionStorage.getItem('KD_TOKEN');
            const d = await (await fetch('/api/v1/dispatcher/dashboard',{headers:{Authorization:'Bearer '+t}})).json();
            const c = (d.queue||[]).find(x => x.jobId === ${JSON.stringify(claimable)});
            return c ? String(c.claimedByStaffId === d.myShift.staffUserId) : 'gone';
        })()`, true);
        if (mine === 'true') ok('clicking "Take this ride" claims it on the server');
        else bad(`claim did not reach the server (${mine})`);
    } else {
        console.log('  SKIP  no unclaimed request to take');
    }

    // ── 3. The assignment sheet opens from a real click ──────────────────
    await sleep(1500);
    const hasChoose = await js(`!!document.querySelector('[data-open-sheet]')`);
    if (hasChoose) {
        await clickSelector('[data-open-sheet]');
        await sleep(800);
        const open = await js(`!document.getElementById('sheet').classList.contains('hidden')`);
        if (open) ok('clicking a driver opens the assignment sheet'); else bad('sheet did not open');

        // And it must NOT have assigned anything by opening.
        const assigned = await js(`(async () => {
            const t = sessionStorage.getItem('KD_TOKEN');
            const d = await (await fetch('/api/v1/dispatcher/dashboard',{headers:{Authorization:'Bearer '+t}})).json();
            return String((d.queue||[]).some(c => c.status === 'pending_acceptance'));
        })()`, true);
        if (assigned === 'false') ok('opening the sheet assigns nobody'); else bad('opening the sheet caused an assignment');

        await clickSelector('#sheet-cancel');
        await sleep(500);
        const closed = await js(`document.getElementById('sheet').classList.contains('hidden')`);
        if (closed) ok('Cancel closes the sheet'); else bad('Cancel did nothing');
    } else {
        console.log('  SKIP  no assignable driver to choose');
    }

    // ── 4. No CSP violations at all ──────────────────────────────────────
    if (cspViolations.length === 0) ok('no Content-Security-Policy violations');
    else { bad(`${cspViolations.length} CSP violation(s)`); cspViolations.slice(0, 3).forEach(v => console.log('        ' + v.slice(0, 130))); }

    function finish() {
        console.log(`\n  ${pass} passed, ${fail} failed`);
        ws.close(); chrome.kill();
        setTimeout(() => {
            try { require('fs').rmSync(profile, { recursive: true, force: true }); } catch {}
            process.exit(fail === 0 ? 0 : 1);
        }, 300);
    }
    finish();
}

main().catch(e => { console.error('UI TEST FAILED:', e.message); process.exit(1); });
