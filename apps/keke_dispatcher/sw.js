/*
 * KekeRide Park Dispatch — service worker.
 *
 * ── What this caches, and what it must never cache ──────────────────────
 * The APP SHELL only: HTML, CSS, JS, icons, manifest. That is what makes the
 * app open instantly on a park tablet over a bad connection, and it contains
 * nothing about any passenger or ride.
 *
 * Every /api/ and /socket.io/ request goes straight to the network, always.
 * A dispatcher acting on a cached queue would be assigning drivers to rides
 * that may have been taken, cancelled or expired minutes ago — worse than
 * showing nothing. When the network is gone the app says so; it does not
 * quietly serve yesterday's board.
 *
 * ── Updates ─────────────────────────────────────────────────────────────
 * A new worker installs, then waits. The page is told, and the dispatcher
 * decides when to reload — never mid-assignment. `SKIP_WAITING` is sent by the
 * page when they accept.
 */

/**
 * Bump on every shell change. The old cache is deleted on activate, so a stale
 * build cannot outlive a deploy.
 */
const VERSION = 'v5.9.0';   // Operations: real dialer + driver reassignment
const SHELL_CACHE = `kd-shell-${VERSION}`;

const SHELL = [
    './',
    './index.html',
    './styles.css',
    './operations.css',
    './app.js',
    './operations.js',
    './manifest.webmanifest',
    './icons/icon-192.png',
    './icons/icon-512.png',
    './icons/maskable-512.png',
    './icons/apple-touch-icon-180.png',
    './offline.html',
];

/* ═══════════════════════════════════════════════════════════════════════
 * Push
 *
 * These live HERE, in the app-shell worker, rather than in a second worker.
 *
 * A page can only have ONE service worker per scope. Registering
 * firebase-messaging-sw.js at the same scope as this file silently REPLACED
 * it — so the app got background push and lost offline start-up, or the other
 * way round depending on which registered last. One worker cannot conflict
 * with itself.
 *
 * Firebase's getToken() accepts any registration, so the page passes this one.
 * ═══════════════════════════════════════════════════════════════════════ */

self.addEventListener('push', (event) => {
    let payload = {};
    try {
        payload = event.data ? event.data.json() : {};
    } catch {
        payload = { notification: { title: 'KekeRide', body: 'You have a new request.' } };
    }

    const n = payload.notification || {};
    const d = payload.data || {};

    const title = n.title || 'New KekeRide request';
    const options = {
        body: n.body || 'Open Park Dispatch to assign a driver.',
        icon: '/dispatch/icons/icon-192.png',
        badge: '/dispatch/icons/icon-192.png',
        /*
         * One notification per job. A reminder REPLACES the first rather than
         * stacking a second on the lock screen, and `renotify` makes the
         * replacement alert again — which is the entire point of a reminder.
         */
        tag: d.jobId ? `park-job-${d.jobId}` : 'park-dispatch',
        renotify: true,
        /*
         * Stays until the dispatcher deals with it. A request that vanishes off
         * the lock screen after four seconds is a request nobody answers.
         */
        requireInteraction: true,
        vibrate: [200, 100, 200, 100, 200],
        data: {
            jobId: d.jobId || null,
            rideId: d.rideId || null,
            parkId: d.parkId || null,
            reason: d.reason || 'new_request',
            url: `/dispatch/index.html${d.jobId ? `?job=${encodeURIComponent(d.jobId)}` : ''}`,
        },
        actions: [
            { action: 'open', title: 'Open Park Dispatch' },
        ],
    };

    event.waitUntil((async () => {
        await self.registration.showNotification(title, options);

        /*
         * Tell the server the worker actually ran.
         *
         * This is the difference between "Google accepted it" and "the device
         * received it" — the strongest evidence available without a human. Best
         * effort: a failed acknowledgement must never stop the notification.
         */
        try {
            await fetch('/api/v1/dispatcher/push/ack', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                    state: 'service_worker_received',
                    jobId: d.jobId || null,
                    // The worker has no session token; the page attaches one on
                    // its own ack. This call is a best-effort signal and the
                    // server treats an unauthenticated one as unknown.
                }),
            });
        } catch { /* the alert matters more than the evidence */ }

        // If a window is open, let it react immediately too.
        const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        for (const c of clients) {
            c.postMessage({ type: 'KD_PUSH_RECEIVED', jobId: d.jobId || null, reason: d.reason || 'new_request' });
        }
    })());
});

/**
 * A tap.
 *
 * Focuses an existing window rather than opening a second one — a dispatcher
 * with three copies of the board open is a dispatcher acting on the wrong one.
 * The job id travels as a hint only; the app re-reads authoritative state on
 * arrival and never assigns from what the notification said.
 */
self.addEventListener('notificationclick', (event) => {
    const data = (event.notification && event.notification.data) || {};
    event.notification.close();

    event.waitUntil((async () => {
        const url = data.url || '/dispatch/index.html';
        const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });

        // An Operations alert names a ride rather than a park job. Opening it
        // must land on that exact ride — a dispatcher woken by a buzz should
        // not have to find the request in a list.
        const opsRide = data.type === 'OPS_QUEUE' ? (data.rideId || null) : null;

        for (const c of clients) {
            if (c.url.includes('/dispatch/')) {
                c.postMessage(opsRide
                    ? { type: 'OPS_OPEN_RIDE', rideId: opsRide }
                    : { type: 'KD_NOTIFICATION_OPENED', jobId: data.jobId || null });
                return c.focus();
            }
        }
        return self.clients.openWindow(
            opsRide
                ? `/dispatch/index.html?ops=1&ride=${encodeURIComponent(opsRide)}`
                : url,
        );
    })());
});

self.addEventListener('install', (event) => {
    event.waitUntil((async () => {
        const cache = await caches.open(SHELL_CACHE);
        // addAll is atomic — one 404 and nothing is cached, leaving the app on
        // the network rather than half-installed.
        await cache.addAll(SHELL);
        // Deliberately NOT skipWaiting() here: see the update note above.
    })());
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        for (const key of await caches.keys()) {
            if (key.startsWith('kd-') && key !== SHELL_CACHE) await caches.delete(key);
        }
        await self.clients.claim();
    })());
});

self.addEventListener('message', (event) => {
    const type = event.data && event.data.type;

    if (type === 'SKIP_WAITING') {
        self.skipWaiting();
        return;
    }

    /*
     * Logout. The shell is not sensitive, but a signed-out device must not keep
     * anything the next person could open, and any future cache that did hold
     * ride data must go with it. Belt and braces: everything we own, dropped.
     */
    if (type === 'CLEAR_SENSITIVE') {
        event.waitUntil((async () => {
            for (const key of await caches.keys()) {
                if (key.startsWith('kd-')) await caches.delete(key);
            }
            // Re-prime the shell so the login screen still loads offline.
            const cache = await caches.open(SHELL_CACHE);
            await cache.addAll(SHELL).catch(() => {});
            const client = event.source;
            if (client) client.postMessage({ type: 'SENSITIVE_CLEARED' });
        })());
    }
});

/** Anything that carries live operational state must not be served from cache. */
function isLiveData(url) {
    return url.pathname.startsWith('/api/')
        || url.pathname.startsWith('/socket.io/')
        || url.pathname.startsWith('/uploads/');
}

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;

    const url = new URL(req.url);
    if (url.origin !== self.location.origin) return;
    if (isLiveData(url)) return;   // straight to the network, no interception

    /*
     * Navigations: network first, so a deployed change is picked up as soon as
     * the network allows, with the cached shell as the fallback. If both fail
     * the dispatcher gets a page that explains itself rather than the browser's
     * dinosaur.
     */
    if (req.mode === 'navigate') {
        event.respondWith((async () => {
            try {
                const fresh = await fetch(req);
                const cache = await caches.open(SHELL_CACHE);
                cache.put('./index.html', fresh.clone()).catch(() => {});
                return fresh;
            } catch {
                return (await caches.match('./index.html'))
                    || (await caches.match('./offline.html'))
                    || new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
            }
        })());
        return;
    }

    /*
     * Shell assets: cache first. They are versioned by the cache name, so
     * "first" is never stale beyond a deploy.
     */
    event.respondWith((async () => {
        const hit = await caches.match(req);
        if (hit) return hit;
        try {
            const fresh = await fetch(req);
            if (fresh.ok && fresh.type === 'basic') {
                const cache = await caches.open(SHELL_CACHE);
                cache.put(req, fresh.clone()).catch(() => {});
            }
            return fresh;
        } catch {
            return new Response('', { status: 504 });
        }
    })());
});
