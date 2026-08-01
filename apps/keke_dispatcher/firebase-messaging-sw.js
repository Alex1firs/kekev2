/*
 * KekeRide Park Dispatch — background push handler.
 *
 * Separate from sw.js on purpose. sw.js owns the app shell and its cache;
 * Firebase's messaging SDK expects its own worker, and mixing the two means an
 * offline-cache change can break notifications or vice versa. Two files, two
 * jobs, neither able to break the other.
 *
 * ── Why this worker imports from a CDN-less bundle ─────────────────────
 * The API sets a strict Content-Security-Policy, and `importScripts` from
 * gstatic would be blocked by `script-src 'self'` in the page context. Service
 * workers are governed by `worker-src`/`script-src` too, so the SDK is loaded
 * from our own origin — see /dispatch/vendor/. If the vendor bundle is absent
 * this worker still handles raw `push` events, which is all we actually need:
 * FCM delivers a standard Web Push, and we can render it ourselves.
 */

/**
 * Configuration arrives by postMessage from the page after sign-in, because
 * a service worker cannot read sessionStorage and we will not bake project
 * identifiers into a committed file.
 */
let CONFIG = null;

self.addEventListener('message', (event) => {
    const data = event.data || {};
    if (data.type === 'KD_PUSH_CONFIG') {
        CONFIG = data.config || null;
    }
});

/**
 * The push itself.
 *
 * Handled with the raw Push API rather than the Firebase SDK's helper: FCM
 * sends a standard Web Push payload, and rendering it directly means one less
 * dependency between a passenger waiting and a dispatcher being told.
 */
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

        for (const c of clients) {
            if (c.url.includes('/dispatch/')) {
                c.postMessage({ type: 'KD_NOTIFICATION_OPENED', jobId: data.jobId || null });
                return c.focus();
            }
        }
        return self.clients.openWindow(url);
    })());
});

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
