/**
 * Build the URL a staff member opens to set their own password.
 *
 * ── Why a link and not a token ──────────────────────────────────────────
 * `createStaff` and `resetCredentials` mint a single-use token. On its own that
 * is a string a supervisor has to explain, transcribe, and hope gets typed
 * correctly into the right place. A link is a thing you send someone, and the
 * page it opens is the only thing that ever sees the password.
 *
 * ── Why the base URL is configuration ───────────────────────────────────
 * It cannot be derived from the request. An operations admin might create an
 * account from `admin.kekeride.ng`, but the dispatcher who has to open the link
 * uses the dispatcher app — and on a phone, in a park. Guessing from the Host
 * header would send them somewhere that does not serve the activation page.
 */

/**
 * Where the dispatcher app is served from, without a trailing slash.
 *
 * `DISPATCH_PUBLIC_URL` should name the host a dispatcher actually opens:
 * https://dispatch.kekeride.ng, or https://api.kekeride.ng/dispatch while the
 * subdomain is pending.
 */
export function dispatchBaseUrl(): string {
    const configured = process.env.DISPATCH_PUBLIC_URL?.trim();
    if (configured) return configured.replace(/\/+$/, '');

    // Fall back to the API host's own /dispatch mount, which is always served.
    const api = process.env.PUBLIC_API_URL?.trim()?.replace(/\/+$/, '');
    if (api) return `${api}/dispatch`;

    return '/dispatch';
}

/**
 * A complete, single-use activation link.
 *
 * The token is placed in the query string because that is what the page can
 * read before rewriting the address bar — see activate.js, which strips it
 * immediately so it does not linger in history or on screen.
 */
export function activationLink(setupToken: string): string {
    return `${dispatchBaseUrl()}/activate.html?token=${encodeURIComponent(setupToken)}`;
}

/**
 * What to tell whoever is handing the link over.
 *
 * Written for a supervisor reading it aloud or pasting it into WhatsApp, not
 * for a developer: it says what the link does, that it works once, and that
 * nobody else — including them — will know the password afterwards.
 */
export function activationInstructions(expiresAt: Date): string {
    return 'Open this link and choose your own password. It works once and expires '
        + `on ${expiresAt.toDateString()}. Nobody else will know your password, including whoever sent you this.`;
}
