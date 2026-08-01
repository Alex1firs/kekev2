# Vendored Firebase JS SDK

`firebase-app-compat.js` and `firebase-messaging-compat.js`, copied verbatim
from `firebase@12.17.0`.

## Why these are committed rather than loaded from a CDN

The API sets a strict Content-Security-Policy with `script-src 'self'`. A
`<script src="https://www.gstatic.com/...">` is blocked outright, and so is
an `importScripts()` of the same from a service worker. Loading them from our
own origin is the only way the dispatcher PWA can use the SDK without widening
the policy — and widening a CSP so a page can pull executable code from a third
party is not a trade worth making for a dispatch tool.

It also means the park tablet fetches them from the same host it already has a
connection to, which on sponsored mobile data is one fewer DNS lookup and TLS
handshake.

## Updating

    cd apps/keke_backend
    npm install firebase@<version>
    cp node_modules/firebase/firebase-app-compat.js ../keke_dispatcher/vendor/
    cp node_modules/firebase/firebase-messaging-compat.js ../keke_dispatcher/vendor/

Then re-run `scripts/pwa_audit.js` — a broken SDK shows up there as a failed
token registration, not as a page that looks fine.
