/*
 * KekeRide Dispatcher workspace.
 *
 * One screen, two panels, no navigation. A dispatcher has seconds and a
 * passenger is waiting, so every action they need is reachable without leaving
 * this view.
 *
 * ── What this client may and may not do ─────────────────────────────────
 * It can claim a request, assign a driver, skip, reject and escalate. It has no
 * code path that advances a ride — no arrival, no start, no completion — because
 * the server has no such endpoint. Once a driver is assigned, the dispatcher is
 * finished and the ride belongs to the driver.
 *
 * ── Live, without a refresh button ──────────────────────────────────────
 * Socket.IO pushes every change. A slow poll runs alongside it purely as a
 * safety net for a dropped socket that has not yet reconnected — a dispatcher
 * must never be looking at a stale board without knowing it, so the connection
 * pill goes red the moment realtime is lost.
 */

'use strict';

// ── Environment ──────────────────────────────────────────────────────────
// Served from the same origin as the API in production; falls back to the local
// backend when opened from a file server during development.
const API_ROOT = (() => {
    const host = window.location.hostname;
    if (host === 'localhost' || host === '127.0.0.1') return 'http://127.0.0.1:4100/api/v1';
    return `${window.location.origin}/api/v1`;
})();
const SOCKET_URL = API_ROOT.replace(/\/api\/v1$/, '');

// ── State ────────────────────────────────────────────────────────────────
const S = {
    accessToken: sessionStorage.getItem('KD_TOKEN') || '',
    refreshToken: sessionStorage.getItem('KD_REFRESH') || '',
    me: null,
    parkId: null,
    shift: null,
    queue: [],
    drivers: [],
    counters: null,
    park: null,
    selectedJobId: null,
    socket: null,
    soundOn: sessionStorage.getItem('KD_SOUND') !== 'off',
    seenJobIds: new Set(),
    queueFilter: '',
    driverFilter: '',
    busy: false,
    lastPayloadAt: 0,
    /** Consecutive dashboard refresh failures. Drives the stale-board warning. */
    failedRefreshes: 0,
    /** Server-declared capabilities, including whether new work is arriving. */
    caps: null,
};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ── API ──────────────────────────────────────────────────────────────────

async function api(path, method = 'GET', body) {
    const doFetch = () => fetch(`${API_ROOT}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${S.accessToken}` },
        body: body ? JSON.stringify(body) : undefined,
    });

    let res = await doFetch();
    // One transparent refresh. A dispatcher mid-shift should never be dumped to
    // a login screen because an access token aged out.
    if (res.status === 401 && await refreshSession()) res = await doFetch();

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        const err = new Error(data.message || `Request failed (${res.status})`);
        err.status = res.status;
        err.code = data.code;
        throw err;
    }
    return data;
}

async function refreshSession() {
    if (!S.refreshToken) return false;
    try {
        const res = await fetch(`${API_ROOT}/staff/auth/refresh`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refreshToken: S.refreshToken }),
        });
        if (!res.ok) return false;
        const data = await res.json();
        S.accessToken = data.accessToken;
        S.refreshToken = data.refreshToken;
        sessionStorage.setItem('KD_TOKEN', S.accessToken);
        sessionStorage.setItem('KD_REFRESH', S.refreshToken);
        return true;
    } catch { return false; }
}

// ── Alerts: a dispatcher must never silently miss a ride ────────────────

/**
 * A short two-tone chime built with the Web Audio API.
 *
 * Synthesised rather than shipped as a file: no asset to fail to load, no
 * autoplay-blocked <audio> element, and it starts within a few milliseconds of
 * the request arriving — which is the whole point.
 */
let audioCtx = null;
function chime(urgent = false) {
    if (!S.soundOn) return;
    try {
        audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
        if (audioCtx.state === 'suspended') audioCtx.resume();
        const now = audioCtx.currentTime;
        const notes = urgent ? [880, 1170, 880, 1170] : [660, 990];
        notes.forEach((freq, i) => {
            const osc = audioCtx.createOscillator();
            const gain = audioCtx.createGain();
            osc.type = 'sine';
            osc.frequency.value = freq;
            // Loud enough to hear over a park, short enough not to be hated.
            gain.gain.setValueAtTime(0.0001, now + i * 0.16);
            gain.gain.exponentialRampToValueAtTime(0.32, now + i * 0.16 + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.16 + 0.15);
            osc.connect(gain); gain.connect(audioCtx.destination);
            osc.start(now + i * 0.16);
            osc.stop(now + i * 0.16 + 0.16);
        });
    } catch { /* sound is an aid, never a requirement */ }
}

function buzz(pattern) {
    try { navigator.vibrate?.(pattern); } catch { /* desktop */ }
}

/** A system notification, so a backgrounded tablet still surfaces the request. */
function systemNotify(title, body) {
    try {
        if (!('Notification' in window) || Notification.permission !== 'granted') return;
        const n = new Notification(title, { body, tag: 'keke-dispatch', renotify: true, requireInteraction: false });
        n.onclick = () => { window.focus(); n.close(); };
    } catch { /* not fatal */ }
}

/** The queue depth in the tab title, for a dispatcher watching another tab. */
function updateTitleBadge() {
    const n = S.queue.length;
    document.title = n > 0 ? `(${n}) KekeRide Dispatcher` : 'KekeRide Dispatcher';
    try { navigator.setAppBadge?.(n); } catch { /* unsupported */ }
}

function toast(message, kind = 'info', ms = 4200) {
    const el = document.createElement('div');
    el.className = `toast toast-${kind}`;
    el.textContent = message;
    $('toasts').appendChild(el);
    setTimeout(() => el.remove(), ms);
}


// ── PWA lifecycle ────────────────────────────────────────────────────────

/**
 * The service worker exists for one reason: a park tablet on bad mobile data
 * must be able to OPEN the app. It caches the shell and nothing operational —
 * every /api/ call goes to the network, always, because a dispatcher acting on
 * a cached queue would be assigning drivers to rides that may already be gone.
 */
let swRegistration = null;
let waitingWorker = null;

async function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    // Requires a secure context. localhost counts; plain http on a LAN IP does
    // not, which is worth knowing before someone tests on 192.168.x.x.
    if (!window.isSecureContext) {
        console.warn('[pwa] insecure context — service worker not registered, app still works online');
        return;
    }
    try {
        swRegistration = await navigator.serviceWorker.register('./sw.js', { scope: './' });

        // Already waiting from a previous visit.
        if (swRegistration.waiting) offerUpdate(swRegistration.waiting);

        swRegistration.addEventListener('updatefound', () => {
            const installing = swRegistration.installing;
            if (!installing) return;
            installing.addEventListener('statechange', () => {
                // "installed" with an existing controller means an UPDATE, not
                // a first install — only then is there anything to offer.
                if (installing.state === 'installed' && navigator.serviceWorker.controller) {
                    offerUpdate(installing);
                }
            });
        });

        /*
         * Check for a new build when the dispatcher returns to the app, rather
         * than on a timer. A shift is hours long and a deploy mid-shift should
         * not go unnoticed until tomorrow.
         */
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) swRegistration.update().catch(() => {});
        });
    } catch (err) {
        console.warn('[pwa] service worker registration failed:', err && err.message);
    }
}

function offerUpdate(worker) {
    waitingWorker = worker;
    $('update-bar').classList.remove('hidden');
}

$('update-apply').addEventListener('click', () => {
    if (!waitingWorker) { location.reload(); return; }
    // Reload once the new worker takes control, not before, or the old shell
    // is what gets re-rendered.
    navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true });
    waitingWorker.postMessage({ type: 'SKIP_WAITING' });
});

$('update-later').addEventListener('click', () => {
    // Deliberately dismissible. A dispatcher mid-assignment must not have the
    // page reloaded out from under them.
    $('update-bar').classList.add('hidden');
});

/** Ask the worker to drop everything it holds. Called on sign-out. */
async function clearServiceWorkerCaches() {
    try {
        if (!navigator.serviceWorker || !navigator.serviceWorker.controller) return;
        navigator.serviceWorker.controller.postMessage({ type: 'CLEAR_SENSITIVE' });
        // Also clear anything this page opened directly, in case no worker is
        // controlling (first load after install, or registration failed).
        if (window.caches) {
            for (const key of await caches.keys()) {
                if (key.startsWith('kd-')) await caches.delete(key);
            }
        }
    } catch { /* sign-out must never be blocked by cache cleanup */ }
}

/**
 * Install prompt.
 *
 * Chrome fires this only when the install criteria are met, and only once per
 * page load. Holding it lets us offer installation at a sensible moment —
 * during shift setup — rather than the browser's own mini-infobar.
 */
let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installPrompt = e;
    const btn = $('install-app');
    if (btn) btn.classList.remove('hidden');
});

window.addEventListener('appinstalled', () => {
    installPrompt = null;
    const btn = $('install-app');
    if (btn) btn.classList.add('hidden');
    toast('Park Dispatch installed. Open it from your home screen next time.', 'ok');
});

/** True when running from the home screen rather than a browser tab. */
function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches
        || window.navigator.standalone === true;
}

// ── Network state ────────────────────────────────────────────────────────

/**
 * Whether the board on screen can be trusted.
 *
 * NOT driven by `navigator.onLine`. That property is true whenever the device
 * has any network interface at all, which on a Nigerian mobile network means it
 * stays true while attached to a tower with no usable data — precisely the case
 * a dispatcher most needs warning about. It is used as a hint, never as the
 * decision.
 *
 * What actually decides: consecutive failures of the dashboard request, and how
 * long it has been since the last successful payload. The safety poll runs
 * every 7s, so nothing newer than ~20s old is worth complaining about; past
 * that, the numbers on screen may be describing a queue that has moved on.
 */
const STALE_AFTER_MS = 20_000;

function boardIsStale() {
    return S.failedRefreshes >= 2
        || (S.lastPayloadAt > 0 && Date.now() - S.lastPayloadAt > STALE_AFTER_MS);
}

function renderNetwork() {
    const suspect = !navigator.onLine || boardIsStale();
    const bar = $('offline-bar');
    bar.classList.toggle('hidden', !suspect);
    if (suspect) {
        const seconds = S.lastPayloadAt ? Math.round((Date.now() - S.lastPayloadAt) / 1000) : null;
        bar.querySelector('strong').textContent = navigator.onLine
            ? 'Not receiving updates.'
            : 'This device is offline.';
        bar.querySelector('span').textContent = seconds == null
            ? 'The board below has not loaded. Do not assign from it.'
            : `The board below is ${seconds}s old. Do not assign from it.`;
        setConnection(false);
    }
}

// Re-evaluate on a timer as well as on events: staleness is a function of
// elapsed time, so nothing fires when the board quietly goes cold.
setInterval(() => { if (!document.hidden) renderNetwork(); }, 3000);

window.addEventListener('online', () => {
    renderNetwork();
    toast('Back online. Refreshing the board…', 'ok');
    // Reconcile immediately rather than waiting for the safety poll: the board
    // on screen is by definition stale.
    refreshDashboard().catch(() => {});
    if (S.socket && !S.socket.connected) S.socket.connect();
});
window.addEventListener('offline', renderNetwork);

// ── Sign in ──────────────────────────────────────────────────────────────

$('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('login-btn');
    btn.disabled = true;
    btn.textContent = 'Signing in…';
    $('login-error').classList.add('hidden');
    try {
        const res = await fetch(`${API_ROOT}/staff/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                identifier: $('login-identifier').value.trim(),
                password: $('login-password').value,
            }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.accessToken) {
            /*
             * Show the server's sentence verbatim. It already decides what may
             * safely be said: a generic failure for wrong details, and the
             * specific reason (locked, suspended, setup unfinished) only once
             * the password has proven the account belongs to whoever is typing.
             * Rewriting it here would either leak more or say less.
             */
            $('login-error').textContent = data.message
                || (res.status === 429
                    ? 'Too many attempts. Wait a few minutes and try again.'
                    : 'Those sign-in details are not correct.');
            $('login-error').classList.remove('hidden');
            return;
        }
        S.accessToken = data.accessToken;
        S.refreshToken = data.refreshToken;
        sessionStorage.setItem('KD_TOKEN', S.accessToken);
        sessionStorage.setItem('KD_REFRESH', S.refreshToken);
        await boot();
    } catch {
        $('login-error').textContent = navigator.onLine
            ? 'Could not reach KekeRide. Try again in a moment.'
            : 'This device is offline. Check its mobile data or Wi-Fi.';
        $('login-error').classList.remove('hidden');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Sign in';
    }
});

async function signOut() {
    // Tell the server first so the session is revoked even if the reload is
    // interrupted, then remove every local trace.
    await fetch(`${API_ROOT}/staff/auth/logout`, {
        method: 'POST', headers: { Authorization: `Bearer ${S.accessToken}` },
    }).catch(() => {});

    await clearServiceWorkerCaches();
    sessionStorage.clear();
    try { localStorage.removeItem('KD_LAST_PARK'); } catch { /* private mode */ }

    // Drop in-memory state too: a reload is not guaranteed to be immediate,
    // and nothing about the last shift should survive the click.
    S.accessToken = ''; S.refreshToken = ''; S.me = null; S.shift = null;
    S.queue = []; S.drivers = []; S.counters = null; S.caps = null;
    if (S.socket) { try { S.socket.disconnect(); } catch { /* already gone */ } }

    location.replace('./index.html');
}

// ── Boot ─────────────────────────────────────────────────────────────────

async function boot() {
    renderNetwork();
    registerServiceWorker();
    if (!S.accessToken) { showScreen('login'); return; }
    try {
        S.me = await api('/dispatcher/me');
    } catch {
        sessionStorage.clear();
        showScreen('login');
        return;
    }

    if (!S.me.onDuty) { showShiftGate(); return; }

    S.shift = S.me.currentShift;
    S.parkId = S.shift.parkId;
    showScreen('workspace');

    // Ask once, at the moment it becomes useful — not on page load, which
    // browsers rightly treat as spam.
    if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission().catch(() => {});
    }

    await refreshDashboard(true);
    connectSocket();
    startTicker();
}

function showScreen(which) {
    document.body.classList.remove('booting');
    for (const id of ['login', 'shift-gate', 'workspace']) {
        $(id).classList.toggle('hidden', id !== which);
    }
}

function showShiftGate() {
    showScreen('shift-gate');
    $('shift-who').textContent = `Signed in as ${S.me.name}.`;
    const select = $('shift-park');
    const parks = (S.me.assignedParks || []).filter((p) => p && p.status === 'active');
    select.innerHTML = parks.length
        ? parks.map((p) => `<option value="${esc(p.parkId)}">${esc(p.name)} (${esc(p.code)})</option>`).join('')
        : '<option value="">—</option>';
    $('shift-start').disabled = parks.length === 0;
    $('shift-no-park').classList.toggle('hidden', parks.length > 0);

    // Remember the last park so a dispatcher who works one park does not pick
    // it from a list every morning. Only a convenience — the server decides
    // which parks they may open a shift at.
    try {
        const last = localStorage.getItem('KD_LAST_PARK');
        if (last && parks.some((p) => p.parkId === last)) select.value = last;
    } catch { /* private mode */ }

    renderSetupChecks();
}

/**
 * The pre-shift checks.
 *
 * Everything here is something that is silently broken until the moment it
 * matters: an alert nobody can hear, a notification permission never granted,
 * a Park Dispatch that operations paused an hour ago. Finding out at 07:00 is
 * cheap; finding out when the first passenger is waiting is not.
 */
function renderSetupChecks() {
    const notif = ('Notification' in window) ? Notification.permission : 'unsupported';
    $('notif-state').textContent = {
        granted: 'On',
        denied: 'Blocked in browser settings',
        default: 'Not enabled yet',
        unsupported: 'Not supported on this device',
    }[notif] || notif;
    $('notif-enable').classList.toggle('hidden', notif !== 'default');

    // Installability. The prompt only exists on browsers that offer it, and
    // only when the criteria are met — so absence is not an error, and saying
    // "already installed" when running standalone avoids a confusing button.
    const row = $('install-row');
    if (isStandalone()) {
        row.classList.remove('hidden');
        $('install-app').classList.add('hidden');
        $('install-state').textContent = 'Installed';
    } else if (installPrompt) {
        row.classList.remove('hidden');
        $('install-app').classList.remove('hidden');
        $('install-state').textContent = '';
    } else {
        row.classList.add('hidden');
    }

    // Park Dispatch state, read before the shift rather than discovered from
    // an empty queue.
    api('/dispatcher/me').then(() => api('/dispatcher/switch-state').catch(() => null))
        .then((st) => {
            const el = $('setup-dispatch-state');
            if (!st) { el.textContent = 'Unknown'; el.className = 'setup-state'; return; }
            el.textContent = st.accepting ? 'Running' : `Paused — ${st.reason || 'by operations'}`;
            el.className = `setup-state ${st.accepting ? 'setup-ok' : 'setup-warn'}`;
        })
        .catch(() => { $('setup-dispatch-state').textContent = 'Unknown'; });
}

$('sound-test').addEventListener('click', () => {
    // A real alert, not a different beep: the point is to confirm THIS sound is
    // audible over a park, at this device's volume.
    chime(true);
    buzz([160, 90, 160]);
    toast('That is the sound a new request makes.', 'ok');
});

$('notif-enable').addEventListener('click', async () => {
    try { await Notification.requestPermission(); } catch { /* denied */ }
    renderSetupChecks();
});

$('install-app').addEventListener('click', async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    const { outcome } = await installPrompt.userChoice;
    installPrompt = null;
    $('install-app').classList.add('hidden');
    $('install-state').textContent = outcome === 'accepted' ? 'Installing…' : 'Not installed';
});

$('shift-start').addEventListener('click', async () => {
    const parkId = $('shift-park').value;
    if (!parkId) return;
    $('shift-start').disabled = true;
    $('shift-error').classList.add('hidden');
    try {
        // The park's own coordinates are recorded server-side; sending the
        // device fix lets the server attest the dispatcher is actually on site.
        const coords = await new Promise((resolve) => {
            if (!navigator.geolocation) return resolve(null);
            navigator.geolocation.getCurrentPosition(
                (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
                () => resolve(null),
                { timeout: 5000, maximumAge: 60_000 },
            );
        });
        await api('/dispatcher/shifts/open', 'POST', { parkId, ...(coords || {}) });
        try { localStorage.setItem('KD_LAST_PARK', parkId); } catch { /* private mode */ }
        await boot();
    } catch (err) {
        $('shift-error').textContent = err.message;
        $('shift-error').classList.remove('hidden');
        $('shift-start').disabled = false;
    }
});

$('shift-signout').addEventListener('click', signOut);

$('btn-end-shift').addEventListener('click', async () => {
    if (S.queue.some((c) => c.claimedByStaffId === S.me.staffUserId)) {
        toast('Finish or hand back your claimed requests first.', 'warn');
        return;
    }
    try {
        await api('/dispatcher/shifts/close', 'POST', { handoverNotes: null });
        location.reload();
    } catch (err) { toast(err.message, 'error'); }
});

// ── Realtime ─────────────────────────────────────────────────────────────

function connectSocket() {
    if (S.socket) S.socket.disconnect();
    S.socket = io(SOCKET_URL, {
        auth: { token: S.accessToken },
        transports: ['websocket', 'polling'],
        reconnectionDelayMax: 4000,
    });

    S.socket.on('connect', () => {
        setConnection(true);
        // Joining is authorised server-side against this dispatcher's park
        // scope; a token alone is not enough to watch a park's requests.
        S.socket.emit('join', { userId: S.parkId, role: 'park' });
        refreshDashboard();
    });

    S.socket.on('disconnect', () => setConnection(false));
    S.socket.on('connect_error', () => setConnection(false));

    S.socket.on('park:request_offered', () => {
        // The alert fires on the EVENT, before the refresh returns. A second of
        // silence with a passenger waiting is a second wasted.
        chime(true);
        buzz([160, 90, 160]);
        systemNotify('New ride request', 'A passenger is waiting for a driver.');
        refreshDashboard();
    });

    S.socket.on('park:job_cancelled', (p) => {
        toast('A request was withdrawn — the passenger cancelled or a nearby driver took it.', 'warn');
        if (S.selectedJobId === p?.jobId) S.selectedJobId = null;
        refreshDashboard();
    });

    S.socket.on('park:job_expired', () => {
        chime(true); buzz([300]);
        toast('A request expired before it could be filled.', 'error', 6000);
        refreshDashboard();
    });

    S.socket.on('park:job_driver_declined', (p) => {
        // The dispatcher chose somebody who is not coming. They need to act
        // again, immediately, so this is as loud as a new request.
        chime(true); buzz([200, 80, 200]);
        toast(`Driver declined — pick another. (${p?.declineCount || 1} so far)`, 'error', 7000);
        refreshDashboard();
    });

    S.socket.on('park:job_pending_driver', () => refreshDashboard());
    S.socket.on('park:job_assigned', (p) => {
        if (p?.acceptedByDriver) { chime(); toast('Driver accepted. The ride is theirs now.', 'success'); }
        refreshDashboard();
    });
}

function setConnection(up) {
    const el = $('conn');
    el.className = `conn ${up ? 'conn-up' : 'conn-down'}`;
    el.textContent = up ? 'live' : 'offline';
}

// ── Data ─────────────────────────────────────────────────────────────────

let refreshInFlight = false;
async function refreshDashboard(initial = false) {
    if (refreshInFlight) return;
    refreshInFlight = true;
    try {
        const d = await api('/dispatcher/dashboard');
        S.park = d.park;
        S.counters = d.counters;
        S.caps = d.capabilities || null;
        S.drivers = d.drivers || [];
        S.shift = d.myShift || S.shift;
        S.lastPayloadAt = Date.now();
        S.failedRefreshes = 0;

        const previous = S.queue;
        S.queue = d.queue || [];

        if (!initial) {
            // A request that arrived while the socket was briefly down still
            // deserves the same alert it would have got live.
            const fresh = S.queue.filter((c) => !S.seenJobIds.has(c.jobId));
            if (fresh.length > 0 && previous.length > 0) {
                chime(true); buzz([160, 90, 160]);
            }
        }
        S.queue.forEach((c) => S.seenJobIds.add(c.jobId));

        // Keep a sensible selection: the dispatcher's own claimed job, else the
        // most urgent. Never leave a stale selection pointing at nothing.
        if (!S.queue.some((c) => c.jobId === S.selectedJobId)) {
            const mine = S.queue.find((c) => c.claimedByStaffId === S.me.staffUserId);
            S.selectedJobId = (mine || S.queue[0])?.jobId ?? null;
        }
        render();
        renderNetwork();
    } catch (err) {
        if (err.status === 401) { sessionStorage.clear(); location.reload(); return; }
        if (err.status === 409) { showShiftGate(); return; }
        S.failedRefreshes += 1;
        setConnection(false);
        renderNetwork();
    } finally {
        refreshInFlight = false;
    }
}

/**
 * A slow poll alongside the socket.
 *
 * Not the primary update path — the socket is. This exists so a dropped
 * connection that has not yet reconnected cannot leave a dispatcher staring at
 * a board that stopped changing.
 */
setInterval(() => { if (!document.hidden) refreshDashboard(); }, 7000);

/** Countdowns tick locally so the board feels alive between pushes. */
function startTicker() {
    setInterval(() => {
        document.querySelectorAll('[data-expires]').forEach((el) => {
            const left = Math.max(0, Math.round((new Date(el.dataset.expires) - Date.now()) / 1000));
            el.textContent = `${left}s`;
            el.className = `countdown ${left <= 5 ? 'countdown-crit' : left <= 12 ? 'countdown-warn' : 'countdown-ok'}`;
            const card = el.closest('.card');
            if (card) card.classList.toggle('card-expiring', left <= 8);
        });
    }, 1000);
}

// ── Render ───────────────────────────────────────────────────────────────

function render() {
    renderPaused();
    renderHeader();
    renderCounters();
    renderQueue();
    renderDrivers();
    updateTitleBadge();
}

/**
 * Park Dispatch can be paused centrally during an incident. When it is, the
 * queue simply stops filling — which is indistinguishable from a quiet morning
 * unless we say so. Claiming and assigning stay available, because jobs already
 * in the queue must still be finished.
 */
function renderPaused() {
    const paused = S.caps && S.caps.parkDispatchEnabled === false;
    $('paused').classList.toggle('hidden', !paused);
    if (paused) {
        $('paused-reason').textContent = S.caps.pausedReason || 'Paused by operations';
    }
}

function renderHeader() {
    $('hdr-park').textContent = S.park?.name || '—';
    $('hdr-code').textContent = S.park?.code || '—';
    $('hdr-shift').textContent = S.shift
        ? `${S.me.name} · on duty ${S.shift.durationMinutes}m`
        : `${S.me.name} · no shift`;
    $('btn-sound').textContent = S.soundOn ? '🔔' : '🔕';
}

function renderCounters() {
    const c = S.counters;
    if (!c) return;
    const tiles = [
        ['queue', c.queueDepth, c.queueDepth > 0 ? 'counter-alert' : ''],
        ['mine', c.activeAssignments, ''],
        ['awaiting', c.awaitingDriverResponse, c.awaitingDriverResponse > 0 ? 'counter-alert' : ''],
        ['ready', c.availableDrivers, c.availableDrivers > 0 ? 'counter-good' : 'counter-alert'],
        ['on trip', c.driversOnTrips, ''],
        ['unavail', c.driversUnavailable, ''],
        ['offline', c.driversOffline, ''],
        ['park use', `${c.parkUtilisationPct}%`, ''],
        ['avg wait', c.avgPassengerWaitSeconds == null ? '—' : `${c.avgPassengerWaitSeconds}s`, ''],
        ['response', c.dispatcherResponseSeconds == null ? '—' : `${c.dispatcherResponseSeconds}s`, ''],
        ['assigned', c.jobsAssignedToday, ''],
        ['completed', c.jobsCompletedToday, ''],
        ['failed', c.failedAssignmentsToday, c.failedAssignmentsToday > 0 ? 'counter-alert' : ''],
        ['escalated', c.escalatedJobsToday, c.escalatedJobsToday > 0 ? 'counter-alert' : ''],
    ];
    $('counters').innerHTML = tiles
        .map(([label, value, cls]) => `<div class="counter ${cls}"><b>${esc(value)}</b><span>${esc(label)}</span></div>`)
        .join('');
}

function matches(text, filter) {
    return !filter || String(text).toLowerCase().includes(filter);
}

function renderQueue() {
    const list = S.queue.filter((c) => matches(
        `${c.passengerName} ${c.pickupAddress} ${c.destinationAddress}`, S.queueFilter));

    $('queue-count').textContent = String(S.queue.length);
    $('queue-count').className = `pill ${S.queue.length ? '' : 'pill-zero'}`;
    $('queue-empty').style.display = list.length ? 'none' : 'flex';

    $('queue').innerHTML = list.map((c) => {
        const isMine = c.claimedByStaffId === S.me.staffUserId;
        const pending = c.status === 'pending_acceptance';
        const selected = c.jobId === S.selectedJobId;
        const isNew = !S.seenJobIds.has(c.jobId);

        return `
        <article class="card card-p${c.priority} ${selected ? 'selected' : ''} ${isNew ? 'card-new' : ''}"
                 role="listitem" data-job="${esc(c.jobId)}" onclick="selectJob('${esc(c.jobId)}')">
            <div class="card-top">
                <div>
                    <div class="card-name">${esc(c.passengerName)}</div>
                    <div class="card-meta">${esc(c.passengerPhoneMasked || 'no number')} · ${esc(c.paymentMode)}</div>
                </div>
                <div style="text-align:right">
                    <div class="card-fare">₦${Number(c.estimatedFare).toLocaleString()}</div>
                    <div class="card-meta"><span class="countdown" data-expires="${esc(c.expiresAt)}">—</span></div>
                </div>
            </div>

            <div class="route">
                <div class="route-line"><span class="route-dot dot-pickup"></span><span>${esc(c.pickupAddress || 'Pickup not named')}</span></div>
                <div class="route-line"><span class="route-dot dot-drop"></span><span>${esc(c.destinationAddress || 'Destination not named')}</span></div>
            </div>

            <div class="card-tags">
                <span class="tag tag-${esc(c.priorityLabel)}">${esc(c.priorityLabel)}</span>
                <span class="tag tag-wait">waiting ${fmtWait(c.waitingSeconds)}</span>
                ${c.estimatedTravelMinutes != null ? `<span class="tag">${c.estimatedTravelMinutes} min away</span>` : ''}
                ${c.parksTried > 1 ? `<span class="tag">${c.parksTried} parks tried</span>` : ''}
                ${pending ? '<span class="tag tag-pending">waiting on driver</span>' : ''}
                ${isMine && !pending ? '<span class="tag">yours</span>' : ''}
            </div>

            <div class="card-actions">
                ${!isMine && !pending
                    ? `<button class="btn btn-primary btn-sm" onclick="event.stopPropagation();claimJob('${esc(c.jobId)}')">Take this ride</button>`
                    : ''}
                ${isMine && !pending
                    ? `<button class="btn btn-sm" onclick="event.stopPropagation();skipJob('${esc(c.jobId)}')">Skip</button>
                       <button class="btn btn-sm" onclick="event.stopPropagation();escalateJob('${esc(c.jobId)}')">Escalate</button>
                       <button class="btn btn-danger btn-sm" onclick="event.stopPropagation();rejectJob('${esc(c.jobId)}')">Reject</button>`
                    : ''}
                ${pending ? '<span class="card-meta">Offer sent — waiting for the driver to accept.</span>' : ''}
            </div>
        </article>`;
    }).join('');
}

function fmtWait(seconds) {
    if (seconds < 60) return `${seconds}s`;
    const m = Math.floor(seconds / 60);
    return `${m}m ${seconds % 60}s`;
}

function renderDrivers() {
    const selected = S.queue.find((c) => c.jobId === S.selectedJobId);
    const banner = $('selected-banner');

    if (selected && selected.claimedByStaffId === S.me.staffUserId && selected.status !== 'pending_acceptance') {
        banner.classList.remove('hidden');
        banner.innerHTML = `Assigning <b>${esc(selected.passengerName)}</b> · ${esc(selected.pickupAddress || 'pickup')} → ${esc(selected.destinationAddress || 'destination')}`;
    } else if (selected && selected.status === 'pending_acceptance') {
        banner.classList.remove('hidden');
        banner.innerHTML = `Waiting for the driver to accept <b>${esc(selected.passengerName)}</b>'s ride.`;
    } else if (selected) {
        banner.classList.remove('hidden');
        banner.innerHTML = `Take <b>${esc(selected.passengerName)}</b>'s ride first, then choose a driver.`;
    } else {
        banner.classList.add('hidden');
    }

    const canAssign = !!selected
        && selected.claimedByStaffId === S.me.staffUserId
        && selected.status !== 'pending_acceptance';

    const list = S.drivers.filter((d) => matches(
        `${d.firstName} ${d.lastName} ${d.unitNumber} ${d.vehiclePlate}`, S.driverFilter));

    /**
     * This counts drivers who can actually take a ride right now, which is
     * almost always fewer than the rows on screen — the rest are listed so the
     * dispatcher can see *why* they are unavailable (no badge, owes a balance,
     * on a trip). A bare number above a longer list reads as a bug, so the
     * pill says what it counts.
     */
    const ready = S.drivers.filter((d) => d.assignable).length;
    $('driver-count').textContent = `${ready} can take a ride`;
    $('driver-count').className = `pill ${ready ? '' : 'pill-zero'}`;
    $('driver-count').title = `${ready} of ${S.drivers.length} drivers at this park can be assigned now`;
    $('drivers-empty').style.display = list.length ? 'none' : 'flex';

    $('drivers').innerHTML = list.map((d, i) => `
        <div class="driver ${d.recommended ? 'driver-recommended' : ''} ${d.assignable ? '' : 'driver-blocked'}" role="listitem">
            <div class="driver-key">${i < 9 ? i + 1 : '·'}</div>
            <div class="driver-main">
                <div class="driver-name">
                    ${esc(d.firstName)} ${esc(d.lastName)}
                    <span class="driver-unit">${esc(d.unitNumber || d.vehiclePlate)}</span>
                </div>
                <div class="driver-reason">${esc(d.reason)}</div>
                <div class="driver-badges">
                    ${d.badges.map((b) => `<span class="badge badge-${esc(b)}">${esc(b.replace(/_/g, ' '))}</span>`).join('')}
                </div>
            </div>
            <div class="driver-assign">
                ${d.assignable && canAssign
                    ? `<button class="btn btn-primary btn-sm" onclick="assignDriver('${esc(d.driverId)}', ${d.requiresVerbalAssignment})">
                         ${d.requiresVerbalAssignment ? 'Assign verbally' : 'Assign'}
                       </button>`
                    : ''}
            </div>
        </div>`).join('');
}

// ── Actions ──────────────────────────────────────────────────────────────

function selectJob(jobId) {
    S.selectedJobId = jobId;
    render();
}

async function guard(fn) {
    // A double-tap on a tablet must not fire an action twice.
    if (S.busy) return;
    S.busy = true;
    try { await fn(); } finally { S.busy = false; }
}

function claimJob(jobId) {
    return guard(async () => {
        try {
            await api(`/dispatcher/requests/${jobId}/claim`, 'POST', {});
            S.selectedJobId = jobId;
            toast('Yours. Now pick a driver.', 'success', 2500);
            await refreshDashboard();
        } catch (err) {
            toast(err.message, 'error');
            await refreshDashboard();
        }
    });
}

/**
 * One tap. No confirmation modal.
 *
 * The dispatcher has already chosen the driver by looking at them across the
 * park; a dialog asking "are you sure" adds a second per assignment and teaches
 * people to tap through dialogs without reading, which is worse than the mistake
 * it claims to prevent. A wrong assignment is recoverable — the driver declines,
 * or the dispatcher reassigns.
 */
function assignDriver(driverId, verbal) {
    return guard(async () => {
        const jobId = S.selectedJobId;
        if (!jobId) { toast('Select a request first.', 'warn'); return; }
        try {
            const res = await api(`/dispatcher/requests/${jobId}/assign`, 'POST', {
                driverId,
                mode: verbal ? 'verbal' : 'electronic',
            });
            if (res.pending) {
                toast('Offer sent. Waiting for the driver to accept.', 'info', 5000);
            } else {
                chime();
                toast('Assigned. The ride is the driver\'s now — nothing more from you.', 'success', 5000);
            }
            await refreshDashboard();
        } catch (err) {
            chime(true); buzz([300]);
            toast(err.message, 'error', 7000);
            await refreshDashboard();
        }
    });
}

function promptResolve(jobId, action, title) {
    return guard(async () => {
        const reason = prompt(`${title}\n\nReason (recorded against your name):`);
        if (reason == null) return;
        if (!reason.trim()) { toast('A reason is required.', 'warn'); return; }
        try {
            await api(`/dispatcher/requests/${jobId}/${action}`, 'POST', { reason: reason.trim() });
            toast('Done.', 'success', 2500);
            if (S.selectedJobId === jobId) S.selectedJobId = null;
            await refreshDashboard();
        } catch (err) { toast(err.message, 'error'); }
    });
}

const skipJob = (jobId) => promptResolve(jobId, 'skip', 'No driver here for this ride.');
const rejectJob = (jobId) => promptResolve(jobId, 'reject', 'Decline this request.');
const escalateJob = (jobId) => promptResolve(jobId, 'escalate', 'Send to support. The ride keeps searching.');

// ── Filters ──────────────────────────────────────────────────────────────

$('queue-search').addEventListener('input', (e) => {
    S.queueFilter = e.target.value.trim().toLowerCase();
    renderQueue();
});
$('driver-search').addEventListener('input', (e) => {
    S.driverFilter = e.target.value.trim().toLowerCase();
    renderDrivers();
});

$('btn-sound').addEventListener('click', () => {
    S.soundOn = !S.soundOn;
    sessionStorage.setItem('KD_SOUND', S.soundOn ? 'on' : 'off');
    renderHeader();
    if (S.soundOn) chime();
});

// ── Keyboard ─────────────────────────────────────────────────────────────
// A desktop dispatcher handling volume should never need the mouse.

document.addEventListener('keydown', (e) => {
    const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
    if (typing && e.key !== 'Escape') return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if ($('workspace').classList.contains('hidden')) return;

    const index = S.queue.findIndex((c) => c.jobId === S.selectedJobId);
    const selected = S.queue[index];

    switch (e.key) {
        case 'ArrowDown':
            e.preventDefault();
            if (S.queue.length) selectJob(S.queue[Math.min(S.queue.length - 1, index + 1)].jobId);
            break;
        case 'ArrowUp':
            e.preventDefault();
            if (S.queue.length) selectJob(S.queue[Math.max(0, index - 1)].jobId);
            break;
        case 'Enter':
            if (selected && selected.claimedByStaffId !== S.me.staffUserId) {
                e.preventDefault(); claimJob(selected.jobId);
            }
            break;
        case '/':
            e.preventDefault(); $('queue-search').focus();
            break;
        case 'Escape':
            document.activeElement?.blur();
            break;
        case 's': case 'S':
            $('btn-sound').click();
            break;
        case 'k': case 'K':
            if (selected) skipJob(selected.jobId);
            break;
        case 'e': case 'E':
            if (selected) escalateJob(selected.jobId);
            break;
        case 'v': case 'V': {
            // Assign the recommended driver verbally — the feature-phone path,
            // which is the common case at most parks.
            const d = S.drivers.find((x) => x.assignable);
            if (d) assignDriver(d.driverId, true);
            break;
        }
        default: {
            // 1–9 assign the nth listed driver. The recommended one is always
            // first, so "1" is the answer the dispatcher wanted in most cases.
            if (/^[1-9]$/.test(e.key)) {
                const d = S.drivers.filter((x) => matches(
                    `${x.firstName} ${x.lastName} ${x.unitNumber} ${x.vehiclePlate}`, S.driverFilter))[Number(e.key) - 1];
                if (d && d.assignable) assignDriver(d.driverId, d.requiresVerbalAssignment);
                else if (d) toast(d.reason, 'warn');
            }
        }
    }
});

// Reconnect and refresh the moment the tablet wakes.
document.addEventListener('visibilitychange', () => {
    if (!document.hidden && S.parkId) {
        if (S.socket && !S.socket.connected) S.socket.connect();
        refreshDashboard();
    }
});

window.addEventListener('online', () => { if (S.socket) S.socket.connect(); });

// Expose the handlers the inline markup calls.
Object.assign(window, { selectJob, claimJob, assignDriver, skipJob, rejectJob, escalateJob });

boot();
