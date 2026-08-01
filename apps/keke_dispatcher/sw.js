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
const VERSION = 'v5.0.0';
const SHELL_CACHE = `kd-shell-${VERSION}`;

const SHELL = [
    './',
    './index.html',
    './styles.css',
    './app.js',
    './manifest.webmanifest',
    './icons/icon-192.png',
    './icons/icon-512.png',
    './icons/maskable-512.png',
    './icons/apple-touch-icon-180.png',
    './offline.html',
];

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
