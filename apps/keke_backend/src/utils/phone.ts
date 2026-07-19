/**
 * Phone number formatting helpers.
 *
 * Numbers are stored in various shapes (international `+2347012345678`, bare
 * `2347012345678`, or local `07012345678`). Drivers/passengers dial each other
 * straight from the app, so we normalise to the Nigerian LOCAL dialable format
 * (`0XXXXXXXXXX`) on the server before emitting — the apps just open whatever
 * string they receive in the dialer, so this fixes dialing for everyone the
 * instant the backend redeploys, with no app update.
 */

/**
 * Convert a phone number to the Nigerian local dialable format (0XXXXXXXXXX).
 * Recognised inputs are normalised; anything unexpected (other country codes,
 * malformed values) is returned unchanged so we never corrupt a number.
 */
export function toLocalDialable(raw?: string | null): string | null | undefined {
    if (raw == null) return raw;                 // preserve null/undefined
    const digits = String(raw).replace(/[^\d]/g, ''); // drop +, spaces, dashes, parens
    if (!digits) return raw;                     // nothing numeric — leave as-is

    // International Nigeria: 234XXXXXXXXXX (13 digits) -> 0XXXXXXXXXX
    if (digits.startsWith('234') && digits.length === 13) {
        return '0' + digits.slice(3);
    }
    // Already local: 0XXXXXXXXXX (11 digits) — return cleaned (strips separators)
    if (digits.startsWith('0') && digits.length === 11) {
        return digits;
    }
    // Missing leading zero: 7/8/9 + 9 digits -> prepend 0
    if (digits.length === 10 && /^[789]/.test(digits)) {
        return '0' + digits;
    }
    // Unknown shape — return original untouched.
    return raw;
}
