/**
 * Screenshot the Communications dashboard, using real production data.
 *
 * The admin dashboard needs a staff login, and driving a password field is not
 * something this harness should do. So instead it serves the real
 * `apps/keke_admin` files, stubs `adminFetch` with a snapshot captured from
 * production, and renders the genuine UI against genuine values. What comes out
 * is what an administrator sees, minus the login.
 *
 * Usage: node scripts/dashboard_screenshots.js <snapshot.json> <outdir>
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ADMIN_DIR = path.resolve(__dirname, '../../keke_admin');
const SNAPSHOT = process.argv[2];
const OUTDIR = process.argv[3] || '/tmp';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const VIEWPORTS = [
    { name: 'desktop', width: 1440, height: 2200 },
    { name: 'tablet', width: 834, height: 2000 },
    { name: 'phone', width: 390, height: 2400 },
];

const MIME = {
    '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
    '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

function serve(port) {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            const url = req.url.split('?')[0];
            const file = path.join(ADMIN_DIR, url === '/' ? 'index.html' : url);
            if (!file.startsWith(ADMIN_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
                res.writeHead(404); return res.end('not found');
            }
            res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'text/plain' });
            fs.createReadStream(file).pipe(res);
        });
        server.listen(port, '127.0.0.1', () => resolve(server));
    });
}

async function main() {
    if (!SNAPSHOT || !fs.existsSync(SNAPSHOT)) {
        console.error('usage: node dashboard_screenshots.js <snapshot.json> <outdir>');
        process.exit(1);
    }
    const snapshot = fs.readFileSync(SNAPSHOT, 'utf8');
    fs.mkdirSync(OUTDIR, { recursive: true });

    const PORT = 4700 + Math.floor(Math.random() * 200);
    const server = await serve(PORT);

    const CDP_PORT = 9700 + Math.floor(Math.random() * 200);
    const profile = `/tmp/kkshot-${Date.now()}`;
    const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
        `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });

    let target;
    for (let i = 0; i < 80; i++) {
        await sleep(250);
        try {
            const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
            target = list.find((x) => x.type === 'page');
            if (target) break;
        } catch { /* not up yet */ }
    }
    if (!target) { console.error('Chrome did not start'); process.exit(1); }

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r) => { ws.onopen = r; });

    let msgId = 0;
    const pending = new Map();
    ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    };
    const send = (method, params = {}) => new Promise((resolve) => {
        const id = ++msgId;
        pending.set(id, resolve);
        ws.send(JSON.stringify({ id, method, params }));
    });

    await send('Page.enable');
    await send('Runtime.enable');

    for (const vp of VIEWPORTS) {
        await send('Emulation.setDeviceMetricsOverride', {
            width: vp.width, height: vp.height, deviceScaleFactor: 2, mobile: vp.name === 'phone',
        });

        await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html` });
        await sleep(1200);

        /*
         * Stub the fetch layer and force the dashboard open. The login screen
         * and the section router are bypassed rather than driven, because
         * driving them would mean typing a password.
         */
        const boot = `
            (async () => {
                const SNAP = ${snapshot};
                window.adminFetch = async (p) => {
                    if (p.includes('/communications/dashboard')) return SNAP;
                    return {};
                };
                window.showToast = () => {};
                document.querySelectorAll('.content-section').forEach(s => s.classList.add('hidden'));
                document.getElementById('login-container').style.display = 'none';
                const shell = document.querySelector('.admin-container');
                shell.style.display = 'flex';
                const title = document.getElementById('section-title');
                if (title) title.textContent = 'Communications';
                const sec = document.getElementById('communications');
                sec.classList.remove('hidden');
                sec.style.display = '';
                ccTab = 'dashboard';
                await ccRenderDashboard(document.getElementById('cc-body'));
                ccStopDashboardRefresh();
                return document.getElementById('cc-body').innerHTML.length;
            })()
        `;
        const res = await send('Runtime.evaluate', { expression: boot, awaitPromise: true, returnByValue: true });
        const rendered = res.result?.result?.value;
        if (!rendered || rendered < 500) {
            console.error(`  ${vp.name}: dashboard did not render`,
                JSON.stringify(res.result?.exceptionDetails ?? res.result).slice(0, 400));
            continue;
        }

        await sleep(400);
        const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
        const out = path.join(OUTDIR, `dashboard-${vp.name}.png`);
        fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
        console.log(`  ${vp.name.padEnd(8)} ${vp.width}x${vp.height}  ${out}  (${rendered} chars rendered)`);
    }

    ws.close();
    chrome.kill();
    server.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
