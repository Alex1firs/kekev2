/*
 * Redeem a one-time staff activation link.
 *
 * A separate file rather than an inline script, because the API's CSP sets
 * `script-src 'self'` and `script-src-attr 'none'` — an inline block or an
 * onclick attribute is blocked outright. That caught every button in the
 * dispatcher app once already.
 */

'use strict';

const API_ROOT = (() => {
    const host = window.location.hostname;
    if (host === 'localhost' || host === '127.0.0.1') return 'http://127.0.0.1:4100/api/v1';
    return `${window.location.origin}/api/v1`;
})();

const $ = (id) => document.getElementById(id);

/**
 * Take the token out of the URL immediately.
 *
 * It is single-use, but it stays valid until it is spent — so leaving it in
 * the address bar puts it in browser history, in a screenshot, and on the
 * screen of anyone standing behind a dispatcher at a park counter. Read it
 * once, hold it in memory, and rewrite the URL.
 */
const token = (() => {
    let t = null;
    try {
        t = new URLSearchParams(location.search).get('token');
        if (t) history.replaceState(null, '', location.pathname);
    } catch { /* malformed query string */ }
    return t;
})();

if (!token) {
    $('intro').classList.add('hidden');
    $('err').textContent = 'This link is missing its activation code. Ask whoever set up your account to send it again.';
    $('err').classList.remove('hidden');
}

function fail(message) {
    $('err').textContent = message;
    $('err').classList.remove('hidden');
}

$('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('err').classList.add('hidden');

    const pw1 = $('pw1').value;
    const pw2 = $('pw2').value;

    // Checked here for a fast, kind answer; the server checks it again and is
    // the one that decides.
    if (pw1 !== pw2) return fail('Those two passwords are not the same.');
    if (pw1.length < 12) return fail('Use at least 12 characters.');

    const btn = $('go');
    btn.disabled = true;
    btn.textContent = 'Setting…';

    try {
        const res = await fetch(`${API_ROOT}/staff/auth/set-password`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token, password: pw1 }),
        });
        const data = await res.json().catch(() => ({}));

        if (!res.ok) {
            /*
             * Show the server's own sentence. It distinguishes an expired link
             * from a weak password from an account that cannot be activated,
             * and each needs a different thing done about it.
             */
            fail(data.message || 'That did not work. Ask for a new activation link.');
            btn.disabled = false;
            btn.textContent = 'Set password';
            return;
        }

        $('intro').classList.add('hidden');
        $('done').classList.remove('hidden');
    } catch {
        fail(navigator.onLine
            ? 'Could not reach KekeRide. Try again in a moment.'
            : 'This device is offline. Connect to the internet and try again.');
        btn.disabled = false;
        btn.textContent = 'Set password';
    }
});
