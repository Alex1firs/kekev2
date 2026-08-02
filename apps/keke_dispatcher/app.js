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
    /** Bumped only after a CONFIRMED outcome, so a retry reuses its key. */
    assignAttempt: 1,
    /** Driver ids addressable by number keys, in display order. */
    assignableOrder: [],
    /** How long a smartphone driver has to answer; from the server. */
    acceptWindowMs: 18000,
    /** Server-declared capabilities, including whether new work is arriving. */
    caps: null,
};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ── API ──────────────────────────────────────────────────────────────────

/**
 * Every request is bounded.
 *
 * On a park tablet a stalled connection does not fail, it hangs — and a fetch
 * with no timeout leaves the button disabled and the dispatcher staring at
 * "Assigning…" with no idea whether it worked. A bounded request turns that
 * into a stated outcome they can act on.
 *
 * 12s: comfortably longer than any of these endpoints takes on a bad
 * connection, short enough that nobody stands there wondering.
 */
const REQUEST_TIMEOUT_MS = 12_000;

async function api(path, method = 'GET', body) {
    const doFetch = () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        return fetch(`${API_ROOT}${path}`, {
            method,
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${S.accessToken}` },
            body: body ? JSON.stringify(body) : undefined,
            signal: controller.signal,
        }).finally(() => clearTimeout(timer));
    };

    let res;
    try {
        res = await doFetch();
    } catch (err) {
        // Abort or network failure. Surfaced with no `status`, which callers
        // read as "outcome unknown" rather than "it failed".
        const wrapped = new Error(err.name === 'AbortError'
            ? 'The server did not answer in time.'
            : 'Could not reach the server.');
        wrapped.status = 0;
        throw wrapped;
    }

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

/*
 * ── Unanswered requests keep asking ─────────────────────────────────────
 *
 * A single chime is missed: a park is loud, the tablet is face-down, the
 * dispatcher is talking to a driver. So an unclaimed request re-alerts.
 *
 * It stops. Three reminders, then silence, and any acknowledgement — claiming,
 * skipping, or simply touching the screen — ends it immediately. An alarm that
 * cannot be switched off gets the volume turned down for the whole shift, and
 * then nothing is heard again.
 */
const REALERT_INTERVAL_MS = 25_000;
const REALERT_LIMIT = 3;
let realertTimer = null;
let realertCount = 0;

function unansweredRequests() {
    return S.queue.filter((c) => !c.claimedByStaffId && c.status !== 'pending_acceptance');
}

function startRealert() {
    if (realertTimer) return;
    realertCount = 0;
    realertTimer = setInterval(() => {
        const waiting = unansweredRequests();
        if (waiting.length === 0 || realertCount >= REALERT_LIMIT) { stopRealert(); return; }
        realertCount += 1;
        chime(true);
        buzz([160, 90, 160]);
        const oldest = Math.max(...waiting.map((c) => c.waitingSeconds || 0));
        systemNotify(
            `${waiting.length} request${waiting.length === 1 ? '' : 's'} waiting`,
            `Longest wait ${fmtWait(oldest)}. Nobody has taken ${waiting.length === 1 ? 'it' : 'them'} yet.`,
        );
    }, REALERT_INTERVAL_MS);
}

function stopRealert() {
    if (realertTimer) clearInterval(realertTimer);
    realertTimer = null;
    realertCount = 0;
}

/** Any deliberate interaction counts as "I have seen it". */
['pointerdown', 'keydown'].forEach((evt) =>
    document.addEventListener(evt, () => { if (realertTimer) stopRealert(); }, { passive: true }));

/** The banner that stays up while anything is unanswered. */
function renderPendingBanner() {
    const waiting = unansweredRequests();
    const bar = $('waiting-bar');
    if (waiting.length === 0) { bar.classList.add('hidden'); stopRealert(); return; }

    const oldest = Math.max(...waiting.map((c) => c.waitingSeconds || 0));
    bar.classList.remove('hidden');
    bar.querySelector('strong').textContent =
        `${waiting.length} request${waiting.length === 1 ? '' : 's'} not taken`;
    bar.querySelector('span').textContent = `Longest wait ${fmtWait(oldest)}.`;
    startRealert();
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


// ── Leaving the app ──────────────────────────────────────────────────────

/**
 * Warn a dispatcher who is about to close or navigate away mid-shift.
 *
 * Web Push is not enabled, so a CLOSED app cannot be woken — no sound, no
 * notification, nothing. A dispatcher who closes the tab at 09:00 will not know
 * a passenger is waiting at 09:05, and neither will anyone else.
 *
 * The browser will not let us choose the wording; every modern browser shows
 * its own generic "Leave site?" text. What we control is WHETHER it appears,
 * and it appears exactly when it matters: on shift.
 */
window.addEventListener('beforeunload', (e) => {
    if (!S.shift) return;                 // not on shift — nothing to lose
    if (leavingDeliberately) return;      // signing out or ending a shift

    // Setting returnValue is what triggers the prompt. The string is ignored
    // by browsers but still required by some of them.
    e.preventDefault();
    e.returnValue = 'You are on shift. Park Dispatch cannot alert you once this is closed.';
    return e.returnValue;
});

/**
 * Set when the dispatcher is leaving on purpose — ending a shift, signing out,
 * or applying an update. Without it, every intentional exit would also nag.
 */
let leavingDeliberately = false;

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
    leavingDeliberately = true;
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


// ── Push notifications ───────────────────────────────────────────────────

/**
 * The alert that survives a locked screen.
 *
 * Everything above this — the chime, the vibration, the banner — only works
 * while the board is open and in front of somebody. This is the path that
 * reaches a dispatcher whose phone is in their pocket.
 *
 * Read docs/dispatcher_web_push_audit.md §4 before relying on it. The web gets
 * no custom sound and no high-importance channel, and an OEM battery manager
 * can kill the browser's background process on Xiaomi, Huawei and Oppo
 * regardless of anything written here.
 */
const PUSH = {
    supported: 'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window,
    config: null,
    token: null,
    deviceTokenId: null,
    messaging: null,
    error: null,
};

/**
 * A stable identity for THIS browser, kept across token rotations.
 *
 * The FCM token changes; this does not. It is what lets the server say "the
 * same tablet as yesterday, with a new token" rather than counting a second
 * device and sending two copies of every alert.
 */
function deviceId() {
    try {
        let id = localStorage.getItem('KD_DEVICE_ID');
        if (!id) {
            id = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()));
            localStorage.setItem('KD_DEVICE_ID', id);
        }
        return id;
    } catch {
        // Private mode. A per-session id still deduplicates within the session.
        return 'ephemeral-' + Math.random().toString(36).slice(2);
    }
}

function deviceLabel() {
    const ua = navigator.userAgent;
    const m = ua.match(/\((?:Linux; )?Android [\d.]+; ([^)]+?)(?: Build|\))/i);
    if (m) return m[1].slice(0, 60);
    if (/iPhone|iPad/.test(ua)) return 'iOS device';
    return (navigator.platform || 'Browser').slice(0, 60);
}

/** Load the vendored SDK once. Served from our own origin because of the CSP. */
function loadFirebaseSdk() {
    if (window.firebase && window.firebase.messaging) return Promise.resolve();
    const add = (src) => new Promise((resolve, reject) => {
        const el = document.createElement('script');
        el.src = src; el.onload = resolve; el.onerror = () => reject(new Error(`could not load ${src}`));
        document.head.appendChild(el);
    });
    return add('vendor/firebase-app-compat.js').then(() => add('vendor/firebase-messaging-compat.js'));
}

/**
 * Set push up for the signed-in dispatcher.
 *
 * Returns a state object rather than throwing: every failure here is something
 * the setup screen has to explain to a person, and an exception would just
 * become "something went wrong".
 */
async function setUpPush({ interactive = false } = {}) {
    PUSH.error = null;

    if (!PUSH.supported) {
        PUSH.error = 'This browser cannot receive background alerts.';
        return PUSH;
    }
    if (!window.isSecureContext) {
        // The commonest cause of "it works on my laptop but not the tablet".
        PUSH.error = 'Background alerts need a secure (https) connection. On plain http they cannot be enabled.';
        return PUSH;
    }

    // 1. Server configuration.
    try {
        const cfg = await api('/dispatcher/push/config');
        if (!cfg.available) {
            PUSH.error = cfg.message || 'Push is not configured on this server.';
            PUSH.missing = cfg.missing || [];
            return PUSH;
        }
        PUSH.config = cfg.config;
    } catch (err) {
        PUSH.error = `Could not read push settings: ${err.message}`;
        return PUSH;
    }

    // 2. Permission. Only ASK during a deliberate setup step — a permission
    //    prompt on page load is the fastest way to get permanently blocked.
    if (Notification.permission === 'denied') {
        PUSH.error = 'Notifications are blocked for this site. Allow them in the browser settings for this page, then try again.';
        return PUSH;
    }
    if (Notification.permission !== 'granted') {
        if (!interactive) { PUSH.error = 'Notifications are not enabled yet.'; return PUSH; }
        const result = await Notification.requestPermission().catch(() => 'denied');
        if (result !== 'granted') {
            PUSH.error = 'Notifications were not allowed. Alerts will only work while this app is open.';
            return PUSH;
        }
    }

    /*
     * 3. The service worker — the SAME one that caches the app shell.
     *
     * A page has one service worker per scope. Registering a second one for
     * messaging at the same scope silently replaced the first, so the app
     * ended up with either offline start-up or background push but never
     * both. sw.js now handles push itself, and Firebase is handed that
     * registration.
     */
    let swReg;
    try {
        swReg = await navigator.serviceWorker.getRegistration('./')
            || await navigator.serviceWorker.register('./sw.js', { scope: './' });
        await navigator.serviceWorker.ready;
    } catch (err) {
        PUSH.error = `Could not start the alert service: ${err.message}`;
        return PUSH;
    }

    // 4. A token.
    try {
        await loadFirebaseSdk();
        if (!window.firebase.apps.length) window.firebase.initializeApp(PUSH.config);
        PUSH.messaging = window.firebase.messaging();

        PUSH.token = await PUSH.messaging.getToken({
            vapidKey: PUSH.config.vapidPublicKey,
            serviceWorkerRegistration: swReg,
        });
        if (!PUSH.token) { PUSH.error = 'The browser did not return an alert token.'; return PUSH; }
    } catch (err) {
        PUSH.error = `Could not register for alerts: ${err.message}`;
        return PUSH;
    }

    // 5. Bind it to this staff member. The PARK comes from their open shift on
    //    the server — never from anything this client says.
    try {
        const res = await api('/dispatcher/push/register', 'POST', {
            token: PUSH.token,
            deviceId: deviceId(),
            deviceLabel: deviceLabel(),
        });
        PUSH.deviceTokenId = res.deviceTokenId;
        PUSH.registered = true;
        PUSH.boundToShift = res.boundToShift;
    } catch (err) {
        PUSH.error = `Could not save this device: ${err.message}`;
        return PUSH;
    }

    // 6. Hand the worker its configuration and listen for what it reports.
    try {
        navigator.serviceWorker.controller?.postMessage({ type: 'KD_PUSH_CONFIG', config: PUSH.config });
        PUSH.messaging.onMessage((payload) => {
            // Arrived while the app is in the foreground: the OS will not show
            // it, so the in-app alert is what the dispatcher gets.
            chime(true); buzz([160, 90, 160]);
            refreshDashboard().catch(() => {});
            ackPush('service_worker_received', payload?.data?.jobId);
        });
    } catch { /* the registration stands regardless */ }

    return PUSH;
}

/** Tell the server what actually happened on this device. */
function ackPush(state, jobId) {
    if (!PUSH.token) return;
    api('/dispatcher/push/ack', 'POST', { state, jobId: jobId || null, token: PUSH.token })
        .catch(() => { /* evidence is best effort; the alert already happened */ });
}

/*
 * The worker talks to us: a push arrived, or a notification was opened. Opening
 * carries a job id as a HINT — the board is re-read from the server and the
 * selection is only honoured if that job is still really there.
 */
navigator.serviceWorker?.addEventListener('message', async (event) => {
    const d = event.data || {};
    if (d.type === 'KD_PUSH_RECEIVED') {
        ackPush('service_worker_received', d.jobId);
        refreshDashboard().catch(() => {});
    }
    if (d.type === 'KD_NOTIFICATION_OPENED') {
        ackPush('notification_opened', d.jobId);
        await refreshDashboard().catch(() => {});
        openJobFromNotification(d.jobId);
    }
});

/**
 * Select the job a notification pointed at — if it still exists.
 *
 * Never assigns, never acts on what the notification said. A notification can
 * be minutes old, and the request may have been taken, cancelled or expired
 * since; the board is the truth and this only moves the cursor.
 */
function openJobFromNotification(jobId) {
    if (!jobId) return;
    const job = S.queue.find((c) => c.jobId === jobId);
    if (job) {
        selectJob(jobId);
        ackPush('request_viewed', jobId);
    } else {
        toast('That request is no longer waiting — it was taken, cancelled or it expired.', 'warn', 6000);
    }
}

/** A job id in the URL, from a cold start via the notification's link. */
function jobFromUrl() {
    try { return new URLSearchParams(location.search).get('job'); } catch { return null; }
}

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
    leavingDeliberately = true;
    // Tell the server first so the session is revoked even if the reload is
    // interrupted, then remove every local trace.
    await fetch(`${API_ROOT}/staff/auth/logout`, {
        method: 'POST', headers: { Authorization: `Bearer ${S.accessToken}` },
    }).catch(() => {});

    // Stop alerts for this device before the session goes away, or the next
    // person to pick up the tablet keeps receiving the last dispatcher's work.
    if (PUSH.token) {
        await api('/dispatcher/push/unregister', 'POST', {
            token: PUSH.token, deviceId: deviceId(), reason: 'signed out',
        }).catch(() => {});
    }

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

    /*
     * Opened from a notification while the app was closed. The job id is a
     * hint; refreshDashboard has already fetched the authoritative board, and
     * openJobFromNotification only selects it if it is genuinely still there.
     */
    const fromNotification = jobFromUrl();
    if (fromNotification) {
        ackPush('notification_opened', fromNotification);
        openJobFromNotification(fromNotification);
        // Clear it so a later refresh does not re-open a stale request.
        history.replaceState(null, '', location.pathname);
    }

    // Re-register quietly: tokens rotate, and a shift binds the device to a park.
    setUpPush({ interactive: false }).catch(() => {});
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
    renderPushState().catch(() => {});
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

/**
 * Reflect the push state, and decide whether a shift may start silently.
 *
 * "Not working" covers every reason a dispatcher might not be reachable —
 * server not configured, permission denied, no token, insecure origin — and
 * each of them gets its own sentence, because the fix is different in each
 * case and "notifications failed" helps nobody.
 */
async function renderPushState() {
    const stateEl = $('push-state');
    const block = $('push-block');
    const enableBtn = $('push-enable');
    const testBtn = $('push-test');

    let status = null;
    try { status = await api('/dispatcher/push/status'); } catch { /* offline */ }

    const working = !!(status && status.pushConfigured && status.devices.length > 0 && !PUSH.error
        && Notification.permission === 'granted');

    /*
     * The "keep this app open or you will hear nothing" warning predates Web
     * Push and was shown unconditionally, including to dispatchers whose
     * background alerts were working. Telling somebody their alerts do not work
     * when they do is worse than saying nothing: they stop trusting the
     * notification that is meant to get them back to the screen.
     */
    $('shift-keep-open').classList.toggle('hidden', working);

    if (working) {
        stateEl.textContent = 'On';
        stateEl.className = 'setup-state setup-ok';
        enableBtn.classList.add('hidden');
        testBtn.classList.remove('hidden');
        block.classList.add('hidden');
        $('push-override').checked = false;
    } else {
        const reason = PUSH.error
            || (status && !status.pushConfigured
                ? `The server has no push configuration (${(status.missingConfig || []).join(', ') || 'unset'}).`
                : null)
            || (Notification.permission === 'denied'
                ? 'Notifications are blocked for this site in the browser settings.'
                : null)
            || 'Not set up on this device yet.';

        stateEl.textContent = 'Off';
        stateEl.className = 'setup-state setup-warn';
        enableBtn.classList.remove('hidden');
        testBtn.classList.add('hidden');

        block.classList.remove('hidden');
        $('push-block-reason').textContent = ` ${reason} `
            + 'Without them you will only be alerted while this app is open and on screen.';
    }

    // The start button is gated on either working alerts or an explicit,
    // recorded acknowledgement.
    updateShiftStartGate();
}

function updateShiftStartGate() {
    const parks = ($('shift-park').value || '') !== '';
    const blocked = !$('push-block').classList.contains('hidden');
    const acknowledged = $('push-override').checked;
    $('shift-start').disabled = !parks || (blocked && !acknowledged);
}

$('push-override').addEventListener('change', updateShiftStartGate);

$('push-enable').addEventListener('click', async () => {
    const btn = $('push-enable');
    btn.disabled = true; btn.textContent = 'Setting up…';
    await setUpPush({ interactive: true });
    btn.disabled = false; btn.textContent = 'Set up';
    await renderPushState();
    if (!PUSH.error) toast('Background alerts are on for this device.', 'success');
});

$('push-test').addEventListener('click', async () => {
    if (!PUSH.deviceTokenId) { toast('Set up background alerts first.', 'warn'); return; }
    try {
        const r = await api('/dispatcher/push/test', 'POST', { deviceTokenId: PUSH.deviceTokenId });
        // Careful wording: the server can only tell us it was ACCEPTED.
        toast(r.detail, r.accepted ? 'info' : 'error', 8000);
    } catch (err) { toast(err.message, 'error'); }
});

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
        await api('/dispatcher/shifts/open', 'POST', {
            parkId,
            ...(coords || {}),
            deviceId: deviceId(),
            /*
             * Starting without background alerts is a deliberate choice and is
             * recorded as one. Operations can then see which shifts ran with a
             * dispatcher who could only be reached while looking at the screen.
             */
            pushUnavailableAcknowledged: $('push-override').checked || undefined,
        });
        try { localStorage.setItem('KD_LAST_PARK', parkId); } catch { /* private mode */ }
        await boot();
    } catch (err) {
        $('shift-error').textContent = err.message;
        $('shift-error').classList.remove('hidden');
        $('shift-start').disabled = false;
    }
});

$('shift-signout').addEventListener('click', signOut);

/*
 * ── Signing off ─────────────────────────────────────────────────────────
 *
 * Not one tap. A dispatcher leaving is the last moment anybody can act on a
 * request still on the board, so the shift's numbers and its outstanding work
 * go in front of them first — and the server refuses a quiet sign-off while
 * they still hold live requests.
 */
$('btn-end-shift').addEventListener('click', async () => {
    try {
        const { summary } = await api('/dispatcher/shifts/summary');
        showShiftEnd(summary);
    } catch (err) {
        toast(err.message, 'error');
    }
});

function showShiftEnd(summary) {
    const hours = Math.floor(summary.durationMinutes / 60);
    const mins = summary.durationMinutes % 60;
    $('shift-end-duration').textContent =
        `${S.park?.name || 'this park'} \u00b7 on duty ${hours ? `${hours}h ` : ''}${mins}m`;

    const rows = [
        ['Rides assigned', summary.assigned],
        ['Skipped', summary.skipped],
        ['Escalated', summary.escalated],
        ['Rejected', summary.rejected],
        ['Expired before filling', summary.expired],
        ['Average response', summary.avgResponseSeconds == null ? '\u2014' : `${summary.avgResponseSeconds}s`],
    ];
    $('shift-end-stats').innerHTML = rows
        .map(([label, value]) => `<div class="sheet-row"><span>${esc(label)}</span><b>${esc(value)}</b></div>`)
        .join('');

    const warn = $('shift-end-warning');
    const handover = $('shift-end-handover-wrap');

    if (summary.myUnresolved > 0) {
        warn.classList.remove('hidden');
        warn.innerHTML = `<b>${summary.myUnresolved} request${summary.myUnresolved === 1 ? '' : 's'} still in your hands.</b>
            Finish or release ${summary.myUnresolved === 1 ? 'it' : 'them'}, or say who is taking over.
            A passenger is waiting on each one.`;
        handover.classList.remove('hidden');
    } else if (summary.parkUnresolved > 0) {
        // Not this dispatcher's to finish, but worth knowing before they leave
        // — especially if they are the last one on duty.
        warn.classList.remove('hidden');
        warn.innerHTML = `<b>${summary.parkUnresolved} request${summary.parkUnresolved === 1 ? '' : 's'} still open at this park.</b>
            Make sure another dispatcher is on duty before you go.`;
        handover.classList.add('hidden');
    } else {
        warn.classList.add('hidden');
        handover.classList.add('hidden');
    }

    $('shift-end-error').classList.add('hidden');
    $('shift-end-confirm').disabled = false;
    $('shift-end-confirm').textContent = 'End shift';
    $('shift-end').classList.remove('hidden');
}

$('shift-end-cancel').addEventListener('click', () => $('shift-end').classList.add('hidden'));
$('shift-end').addEventListener('click', (e) => {
    if (e.target.id === 'shift-end') $('shift-end').classList.add('hidden');
});

$('shift-end-confirm').addEventListener('click', async () => {
    const btn = $('shift-end-confirm');
    btn.disabled = true;
    btn.textContent = 'Ending\u2026';
    $('shift-end-error').classList.add('hidden');
    try {
        await api('/dispatcher/shifts/close', 'POST', {
            handoverNotes: $('shift-end-handover').value.trim() || null,
        });
        leavingDeliberately = true;
        stopRealert();
        location.replace('./index.html');
    } catch (err) {
        // The server is the authority on whether this shift may end; show its
        // sentence rather than guessing at one.
        $('shift-end-error').textContent = err.message;
        $('shift-end-error').classList.remove('hidden');
        btn.disabled = false;
        btn.textContent = 'End shift';
    }
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

    /*
     * The driver did not answer in time. Distinct from a decline: nobody said
     * no, the offer simply lapsed, and the dispatcher may well pick the same
     * driver again after speaking to them.
     */
    S.socket.on('park:job_offer_timeout', (p) => {
        chime(true); buzz([200, 80, 200]);
        toast(`No answer from ${p?.driverName || 'the driver'} — the request is back with you.`, 'error', 7000);
        refreshDashboard();
    });

    /* Returned for reassignment for any other reason. */
    S.socket.on('park:job_returned', () => {
        chime(true); buzz([200, 80, 200]);
        toast('A request came back for reassignment.', 'warn', 6000);
        refreshDashboard();
    });

    /* Operations paused or resumed Park Dispatch mid-shift. */
    S.socket.on('park:dispatch_suspended', (p) => {
        chime(true);
        toast(`New requests paused: ${p?.reason || 'by operations'}. Finish what you have.`, 'warn', 9000);
        systemNotify('Park Dispatch paused', p?.reason || 'Paused by operations.');
        refreshDashboard();
    });
    S.socket.on('park:dispatch_resumed', () => {
        toast('Park Dispatch is running again.', 'success', 6000);
        refreshDashboard();
    });

    /* A supervisor closed this shift, or the session was revoked. */
    S.socket.on('staff:shift_closed', () => {
        toast('Your shift was closed. Signing out.', 'warn', 5000);
        stopRealert();
        setTimeout(() => location.replace('./index.html'), 2500);
    });
    S.socket.on('park:job_assigned', (p) => {
        if (p?.acceptedByDriver) { chime(); toast('Driver accepted. The ride is theirs now.', 'success'); }
        refreshDashboard();
    });

    S.socket.on('park:job_assignment_failed', (p) => {
        chime(true); buzz([300]);
        toast(`Assignment failed: ${p?.reason || 'the driver could not be reached'}. Pick another.`, 'error', 8000);
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
    /*
     * Nothing to refresh before somebody has signed in.
     *
     * Without this the poll below ran on the LOGIN screen, sent a request with
     * an empty bearer token, got 401, and took the 401 branch — which clears
     * the session and reloads. Every seven seconds, forever. Anyone typing
     * their password watched the field empty itself mid-word, and the browser
     * re-autofilled a saved credential over the top on each reload, which made
     * it look like the password manager was at fault.
     */
    if (!S.accessToken) return;

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
        /*
         * The session is genuinely gone: the one transparent refresh in api()
         * has already been tried and failed. Land on the login screen without
         * reloading — a reload here is what turned a dead session into a loop,
         * and it discards anything already typed.
         */
        if (err.status === 401) {
            sessionStorage.clear();
            S.accessToken = '';
            S.refreshToken = '';
            $('workspace').classList.add('hidden');
            $('shift-gate').classList.add('hidden');
            $('login').classList.remove('hidden');
            $('login-error').textContent = 'Your session ended. Sign in again.';
            $('login-error').classList.remove('hidden');
            return;
        }
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
setInterval(() => {
    if (document.hidden) return;
    // Only while the board is actually on screen. Polling behind the login or
    // shift-gate screens achieves nothing and used to reload the page.
    if ($('workspace').classList.contains('hidden')) return;
    refreshDashboard();
}, 7000);

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
    renderPendingBanner();
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
                 role="listitem" data-job="${esc(c.jobId)}" tabindex="0">
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
                ${c.parkToPickupKm != null ? `<span class="tag">${c.parkToPickupKm.toFixed(1)} km from park</span>` : ''}
                ${c.parksTried > 1 ? `<span class="tag">${c.parksTried} parks tried</span>` : ''}
                ${pending ? '<span class="tag tag-pending">waiting on driver</span>' : ''}
                ${isMine && !pending ? '<span class="tag">yours</span>' : ''}
            </div>

            ${c.directDispatch ? `<div class="card-direct" title="What the app did before ringing the park">
                App tried first: ${esc(c.directDispatch.summary)}
            </div>` : ''}

            <div class="card-actions">
                ${!isMine && !pending
                    ? `<button class="btn btn-primary btn-sm" data-act="claim" data-job="${esc(c.jobId)}">Take this ride</button>`
                    : ''}
                ${isMine && !pending
                    ? `<button class="btn btn-sm" data-act="skip" data-job="${esc(c.jobId)}">Skip</button>
                       <button class="btn btn-sm" data-act="escalate" data-job="${esc(c.jobId)}">Escalate</button>
                       <button class="btn btn-danger btn-sm" data-act="reject" data-job="${esc(c.jobId)}">Reject</button>`
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

    /*
     * Grouped, in the order a dispatcher should read the list: who can go now,
     * who will be free shortly, and who cannot — with the two problems a
     * supervisor can actually fix (money owed, missing badge) called out
     * separately from "busy", because they need a different action.
     *
     * The grouping is the SERVER's, not this file's, so the board, the tests
     * and the audit trail all mean the same thing by "available".
     */
    const GROUPS = [
        ['recommended', 'Recommended'],
        ['available', 'Available'],
        ['returning_soon', 'Returning soon'],
        ['unavailable', 'Unavailable'],
        ['wallet_blocked', 'Wallet blocked'],
        ['verification_issue', 'Badge or verification issue'],
    ];

    // Number keys address assignable drivers only, in display order, so "3"
    // always means the third driver a dispatcher could actually pick.
    let hotkey = 0;
    S.assignableOrder = [];

    $('drivers').innerHTML = GROUPS.map(([group, label]) => {
        const members = list.filter((d) => (d.group || 'unavailable') === group);
        if (members.length === 0) return '';
        const rows = members.map((d) => {
            const key = (d.assignable && canAssign && hotkey < 9) ? ++hotkey : null;
            if (key) S.assignableOrder.push(d.driverId);
            return driverRow(d, key, canAssign);
        }).join('');
        return `<div class="driver-group">
            <div class="driver-group-head">${esc(label)} <span>${members.length}</span></div>
            ${rows}
        </div>`;
    }).join('');
}

/** One driver row. Tapping it OPENS THE SHEET — it never assigns. */
function driverRow(d, hotkey, canAssign) {
    /*
     * Fall back to initials if the photo 404s. A broken-image icon next to a
     * name, on the screen where a dispatcher confirms they are handing a trip
     * to the right person, is worse than no photo at all.
     *
     * Handled by a capturing listener on the list rather than an inline
     * onerror — see the CSP note on the delegated handlers below.
     */
    const photo = d.photoUrl
        ? `<img class="driver-photo" src="${esc(photoUrl(d.photoUrl))}" alt="" loading="lazy"
                data-initials="${esc(initials(d))}">`
        : `<div class="driver-photo driver-photo-none">${esc(initials(d))}</div>`;

    /*
     * Queue position is deliberately absent here — the reason line above
     * already leads with it where it matters, and printing "#1 in queue" twice
     * in two lines reads as a rendering bug.
     */
    const meta = [
        d.requiresVerbalAssignment ? 'feature phone' : 'smartphone',
        d.lastAssignedAt ? `last ride ${fmtAgo(d.lastAssignedAt)}` : 'no ride today',
    ].filter(Boolean).join(' \u00b7 ');

    return `
        <div class="driver ${d.recommended ? 'driver-recommended' : ''} ${d.assignable ? '' : 'driver-blocked'}"
             role="listitem"
             ${d.assignable && canAssign ? `data-driver="${esc(d.driverId)}" tabindex="0"` : ''}>
            <div class="driver-key">${hotkey || '\u00b7'}</div>
            ${photo}
            <div class="driver-main">
                <div class="driver-name">
                    ${esc(d.firstName)} ${esc(d.lastName)}
                    <span class="driver-unit">${esc(d.unitNumber || d.vehiclePlate)}</span>
                </div>
                <div class="driver-reason">${esc(d.reason)}</div>
                <div class="driver-meta">${esc(meta)}</div>
                <div class="driver-badges">
                    ${d.badges.map((b) => `<span class="badge badge-${esc(b)}">${esc(b.replace(/_/g, ' '))}</span>`).join('')}
                </div>
            </div>
            <div class="driver-assign">
                ${d.assignable && canAssign
                    ? `<button class="btn btn-primary btn-sm" data-open-sheet="${esc(d.driverId)}">Choose</button>`
                    : ''}
            </div>
        </div>`;
}

function initials(d) {
    return `${(d.firstName || '?')[0]}${(d.lastName || '')[0] || ''}`.toUpperCase();
}

/** Driver photos are served by the API host, which may differ from the page. */
function photoUrl(raw) {
    if (/^https?:/i.test(raw)) return raw;
    return `${SOCKET_URL}/uploads/${String(raw).replace(/^\/?uploads\/?/, '')}`;
}

function fmtAgo(iso) {
    const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.round(mins / 60);
    return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
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
/*
 * ── Assignment: choose, check, confirm ──────────────────────────────────
 *
 * Two steps on purpose. Tapping a driver opens a sheet; the sheet assigns.
 *
 * Phase 4 assigned on the first tap with no confirmation, reasoning that a
 * dispatcher with a passenger waiting should not have to confirm what they
 * deliberately pressed. That holds right up until the list re-ranks under a
 * moving thumb — and then it assigns the wrong driver to a real trip, with no
 * moment at which anybody could have noticed. The sheet costs one tap and
 * makes that impossible.
 */
let sheetDriver = null;

function openAssignSheet(driverId) {
    const job = S.queue.find((c) => c.jobId === S.selectedJobId);
    const driver = S.drivers.find((d) => d.driverId === driverId);
    if (!job || !driver) return;

    // Re-checked here, not only at render: the board may have moved between
    // the list being drawn and the thumb landing on it.
    if (job.claimedByStaffId !== S.me.staffUserId) {
        toast('Take this request before assigning a driver.', 'warn');
        return;
    }
    if (!driver.assignable) {
        toast(`${driver.firstName} cannot take this ride: ${driver.reason}`, 'warn');
        return;
    }

    sheetDriver = driver;

    $('sheet-driver').textContent = `${driver.firstName} ${driver.lastName}`;
    $('sheet-unit').textContent = `${driver.unitNumber || driver.vehiclePlate}`
        + (driver.queuePosition != null ? ` \u00b7 #${driver.queuePosition} in queue` : '');

    const photo = $('sheet-photo');
    photo.className = 'driver-photo driver-photo-none';
    photo.textContent = initials(driver);
    if (driver.photoUrl) {
        // Swap in the photo only once it has actually loaded, so a missing file
        // leaves the initials rather than a broken image.
        const img = new Image();
        img.onload = () => {
            photo.className = 'driver-photo';
            photo.textContent = '';
            photo.appendChild(img);
        };
        img.src = photoUrl(driver.photoUrl);
        img.alt = '';
    }

    $('sheet-pickup').textContent = job.pickupAddress || '\u2014';
    $('sheet-dest').textContent = job.destinationAddress || '\u2014';
    $('sheet-passenger').textContent = job.passengerName || '\u2014';
    $('sheet-fare').textContent = `\u20a6${Number(job.estimatedFare || 0).toLocaleString()}`;

    const seconds = Math.round((S.acceptWindowMs || 18000) / 1000);
    $('sheet-mode').className = `sheet-mode ${driver.requiresVerbalAssignment ? 'sheet-mode-verbal' : 'sheet-mode-electronic'}`;
    $('sheet-mode').innerHTML = driver.requiresVerbalAssignment
        ? `<b>Verbal handoff.</b> ${esc(driver.firstName)} has a feature phone.
           Confirm out loud that they will take this trip before you assign.`
        : `<b>Sent to their phone.</b> ${esc(driver.firstName)} has ${seconds}s to accept.
           If they decline or do not answer, the request comes back to you.`;

    $('sheet-confirm').textContent = driver.requiresVerbalAssignment
        ? 'They agreed \u2014 assign ride' : 'Send to driver';
    $('sheet-confirm').disabled = false;
    $('sheet').classList.remove('hidden');
    $('sheet-confirm').focus();
}

function closeAssignSheet() {
    $('sheet').classList.add('hidden');
    sheetDriver = null;
}

$('sheet-cancel').addEventListener('click', closeAssignSheet);
$('sheet').addEventListener('click', (e) => { if (e.target.id === 'sheet') closeAssignSheet(); });

$('sheet-confirm').addEventListener('click', () => {
    if (!sheetDriver) return;
    const driver = sheetDriver;
    $('sheet-confirm').disabled = true;
    $('sheet-confirm').textContent = 'Assigning\u2026';
    assignDriver(driver.driverId, driver.requiresVerbalAssignment).finally(closeAssignSheet);
});

// Delegated, so rows redrawn by a live update keep working.
$('drivers').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-open-sheet]');
    if (btn) { openAssignSheet(btn.getAttribute('data-open-sheet')); return; }
    const row = e.target.closest('[data-driver]');
    if (row) openAssignSheet(row.getAttribute('data-driver'));
});

/* ── Arrivals ───────────────────────────────────────────────────────────
 *
 * The board shows only drivers who can be assigned right now, which is correct
 * for assigning and useless for recording that somebody turned up: a driver
 * with no presence is not on it. `POST /dispatcher/presence` has existed since
 * the dispatcher API was written and nothing in this app ever called it, so a
 * driver could be rostered and never become present — and a park with no
 * present driver is rejected outright by park selection. Nothing could reach a
 * dispatcher at all.
 *
 * For a feature-phone driver there is no other route: they have no app to
 * report for themselves, so a human at the park does it and it is recorded
 * against that human.
 */

/** The full roster behind the arrivals sheet. Not the assignable board. */
let ARRIVALS = [];

/** What a dispatcher can set, and what each choice means on the ground. */
const PRESENCE_CHOICES = [
    ['at_park', 'At park', 'Here, not yet in the queue'],
    ['waiting', 'Waiting', 'Here and next for work'],
    ['unavailable', 'On break', 'Here but not taking rides'],
    ['offline', 'Left', 'Gone home'],
];

const PRESENCE_LABEL = {
    offline: 'Left', online: 'Online', at_park: 'At park', waiting: 'Waiting',
    assigned: 'Assigned', en_route: 'On the way', passenger_boarding: 'Boarding',
    trip_started: 'On a trip', unavailable: 'On break',
};

async function openArrivals() {
    $('arrivals').classList.remove('hidden');
    $('arrivals-list').innerHTML = '<p class="sheet-note">Loading the roster…</p>';
    try {
        const data = await api('/dispatcher/roster');
        ARRIVALS = data.roster || [];
    } catch {
        // api() has already said what went wrong.
        $('arrivals-list').innerHTML = '<p class="sheet-note">Could not load the roster.</p>';
        return;
    }
    renderArrivals();
}

function renderArrivals() {
    const q = ($('arrivals-search').value || '').trim().toLowerCase();
    const list = ARRIVALS.filter((d) => !q || [
        d.firstName, d.lastName, d.unitNumber, d.vehiclePlate,
    ].some((v) => String(v || '').toLowerCase().includes(q)));

    $('arrivals-empty').classList.toggle('hidden', ARRIVALS.length > 0);

    $('arrivals-list').innerHTML = list.map((d) => {
        const state = d.presenceState || 'offline';
        /*
         * A driver already on a trip must not be quietly marked "at park" from
         * here — that is a real operational change and it belongs to the ride,
         * not to an arrivals list. Show the state and offer nothing.
         */
        const onTrip = ['assigned', 'en_route', 'passenger_boarding', 'trip_started'].includes(state);

        return `
        <div class="arrival-row" data-arrival="${esc(d.driverId)}">
            <div class="arrival-who">
                <b>${esc(d.firstName)} ${esc(d.lastName)}</b>
                <small>
                    ${esc(d.unitNumber || d.vehiclePlate || '')}
                    ${d.featurePhoneOnly ? ' · <span class="chip-verbal">no smartphone</span>' : ''}
                </small>
            </div>
            <div class="arrival-state chip-presence chip-${esc(state)}">${esc(PRESENCE_LABEL[state] || state)}</div>
            <div class="arrival-actions">
                ${onTrip
                    ? '<small>On a trip — changed by the ride, not here.</small>'
                    : PRESENCE_CHOICES.map(([value, label, why]) => `
                        <button class="btn btn-small ${state === value ? 'btn-on' : ''}"
                                data-presence="${esc(value)}" data-driver-id="${esc(d.driverId)}"
                                title="${esc(why)}" ${state === value ? 'disabled' : ''}>${esc(label)}</button>`).join('')}
            </div>
        </div>`;
    }).join('');
}

function setPresence(driverId, state) {
    return guard(async () => {
        await api('/dispatcher/presence', 'POST', { driverId, state });

        // Reflect it locally so the row updates before the roster reloads.
        const row = ARRIVALS.find((d) => d.driverId === driverId);
        if (row) row.presenceState = state;
        renderArrivals();

        toast(`Marked ${PRESENCE_LABEL[state] || state}.`, 'success');

        // The board only lists assignable drivers, so presence changes what is
        // on it. Refresh rather than wait for the next poll.
        refreshDashboard();
    });
}

// Delegated — rows are redrawn on every change, and CSP forbids inline handlers.
$('arrivals-list').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-presence]');
    if (!btn) return;
    setPresence(btn.getAttribute('data-driver-id'), btn.getAttribute('data-presence'));
});

$('arrivals-search').addEventListener('input', renderArrivals);
$('btn-arrivals').addEventListener('click', openArrivals);
$('arrivals-close').addEventListener('click', () => $('arrivals').classList.add('hidden'));
$('arrivals').addEventListener('click', (e) => {
    if (e.target.id === 'arrivals') $('arrivals').classList.add('hidden');
});

function assignDriver(driverId, verbal) {
    return guard(async () => {
        const jobId = S.selectedJobId;
        if (!jobId) { toast('Select a request first.', 'warn'); return; }

        /*
         * One key per (job, driver, attempt). If the reply is lost on a bad
         * connection and the dispatcher retries, the server replays the
         * original outcome rather than assigning again — so a retry cannot
         * produce a second assignment, and the dispatcher is not told
         * "already assigned" for the thing they are still waiting on.
         */
        const idempotencyKey = `${jobId}:${driverId}:${S.assignAttempt}`;

        try {
            const res = await api(`/dispatcher/requests/${jobId}/assign`, 'POST', {
                driverId,
                mode: verbal ? 'verbal' : 'electronic',
                idempotencyKey,
            });
            S.assignAttempt += 1;
            if (res.pending) {
                toast('Sent. Waiting for the driver to accept.', 'info', 5000);
            } else {
                chime();
                toast("Assigned. The ride is the driver's now \u2014 nothing more from you.", 'success', 5000);
            }
            await refreshDashboard();
        } catch (err) {
            chime(true); buzz([300]);
            /*
             * Never say "assigned" on an error, and never burn the idempotency
             * key: a timeout means the outcome is genuinely unknown, so the
             * SAME key must be reusable on retry. The refresh below is what
             * settles it — the board is the truth, not the button.
             */
            toast(!err.status
                ? 'Could not reach the server. Check the board before trying again.'
                : err.message, 'error', 7000);
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

    /*
     * With the sheet open it owns the keyboard. Enter confirms it natively
     * (the confirm button holds focus) and Escape closes it; nothing else
     * should reach the board underneath.
     */
    if (!$('sheet').classList.contains('hidden') && e.key !== 'Escape') return;

    /*
     * Same for arrivals. Without this, the number keys that choose a driver on
     * the board fire while a dispatcher is marking people present over the top
     * of it — selecting a driver they cannot see.
     */
    if (!$('arrivals').classList.contains('hidden')) {
        if (e.key === 'Escape') $('arrivals').classList.add('hidden');
        return;
    }

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
            // The sheet first: Escape should back out of the decision, not
            // just drop focus behind an open dialog.
            if (!$('sheet').classList.contains('hidden')) { closeAssignSheet(); break; }
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
            // The recommended driver — the answer the dispatcher wanted in most
            // cases. Opens the sheet like every other route to an assignment;
            // no key assigns anybody outright.
            const first = S.assignableOrder[0];
            if (first) openAssignSheet(first);
            else toast('No driver here can take a ride right now.', 'warn');
            break;
        }
        default: {
            /*
             * 1–9 address ASSIGNABLE drivers in display order, not the raw
             * list. With the roster grouped, the nth row on screen is often
             * someone who cannot be assigned at all, and a number key that
             * sometimes means "the third driver" and sometimes means "the
             * third row" is a number key nobody can trust.
             */
            if (/^[1-9]$/.test(e.key)) {
                const driverId = S.assignableOrder[Number(e.key) - 1];
                if (driverId) openAssignSheet(driverId);
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

/*
 * ── Why every handler here is delegated ─────────────────────────────────
 *
 * The API sets a strict Content-Security-Policy, and helmet's default includes
 * `script-src-attr 'none'` — which blocks INLINE EVENT HANDLERS outright, not
 * just inline <script> blocks. An `onclick="claimJob(...)"` attribute silently
 * does nothing in production.
 *
 * This was live for a while and no screenshot caught it, because every earlier
 * check drove the API directly instead of tapping the actual buttons. Taking a
 * request, skipping, escalating and rejecting were all dead on a real device.
 *
 * So: no inline handlers anywhere. Everything is a data attribute plus one
 * listener on a container, which also survives the list being re-rendered
 * under the dispatcher's thumb by a live update.
 */
const QUEUE_ACTIONS = { claim: claimJob, skip: skipJob, escalate: escalateJob, reject: rejectJob };

$('queue').addEventListener('click', (e) => {
    const actionBtn = e.target.closest('[data-act]');
    if (actionBtn) {
        e.stopPropagation();
        const fn = QUEUE_ACTIONS[actionBtn.getAttribute('data-act')];
        if (fn) fn(actionBtn.getAttribute('data-job'));
        return;
    }
    const card = e.target.closest('[data-job]');
    if (card) selectJob(card.getAttribute('data-job'));
});

// Keyboard parity: a card is focusable, so Enter/Space must select it too.
$('queue').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const card = e.target.closest('.card[data-job]');
    if (!card) return;
    e.preventDefault();
    selectJob(card.getAttribute('data-job'));
});

/*
 * Image errors do not bubble, so this listens in the CAPTURE phase. Replacing
 * the <img> with its initials keeps a missing file from showing a broken-image
 * glyph next to a driver's name.
 */
$('drivers').addEventListener('error', (e) => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement) || !img.dataset.initials) return;
    const fallback = document.createElement('div');
    fallback.className = 'driver-photo driver-photo-none';
    fallback.textContent = img.dataset.initials;
    img.replaceWith(fallback);
}, true);

boot();
