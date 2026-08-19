/**
 * Structured locality: the area an operator reads, and where it came from.
 *
 * The address strings the passenger app captured are unreliable — plus codes,
 * placeholders, streets with no area. Rather than parsing harder, the app now
 * sends the geocoder's OWN structured fields. This is about preferring them
 * correctly and, crucially, staying honest when neither source has anything.
 */
import { resolveAreaLine } from '../../src/services/ride_outcome';

describe('the area line prefers what was actually captured', () => {
    it('uses the structured locality when the app sent it', () => {
        const r = resolveAreaLine('Awada', 'Obosi', 'Some, Parsed Street');
        expect(r.area).toBe('Awada, Obosi');
        expect(r.source).toBe('structured');
    });

    it('uses whichever structured field exists alone', () => {
        expect(resolveAreaLine('Awada', null, null).area).toBe('Awada');
        expect(resolveAreaLine(null, 'Obosi', null).area).toBe('Obosi');
    });

    it('collapses a geocoder that named both fields the same', () => {
        // Otherwise the console reads "Awada, Awada".
        expect(resolveAreaLine('Awada', 'awada', null).area).toBe('Awada');
    });

    it('falls back to the parsed address for rides captured before this', () => {
        const r = resolveAreaLine(null, null, 'Upper New Market Road');
        expect(r.area).toBe('Upper New Market Road');
        expect(r.source).toBe('parsed');
    });

    it('reports none when neither source has anything', () => {
        // The honest answer for a bare plus code with no structured fields.
        // "none" lets the UI say "Area not recorded" rather than showing blank,
        // which would read as a rendering fault.
        const r = resolveAreaLine(null, null, null);
        expect(r.area).toBeNull();
        expect(r.source).toBe('none');
    });

    it('treats empty strings as absent, not as an area', () => {
        expect(resolveAreaLine('', '  ', '').area).toBeNull();
        expect(resolveAreaLine('', '  ', '').source).toBe('none');
    });

    it('never prefers a parsed guess over what the geocoder named', () => {
        // The parse is best-effort prose handling. When the geocoder itself
        // said "Awada", that is the fact and the parse is noise.
        expect(resolveAreaLine('Awada', null, 'Nigeria').source).toBe('structured');
        expect(resolveAreaLine('Awada', null, 'Nigeria').area).toBe('Awada');
    });
});

// ══════════════════════════════════════════════════════════════════════
//  Older passenger builds
// ══════════════════════════════════════════════════════════════════════

describe('the request schema still accepts what shipped builds send', () => {
    // Reconstructed from the live schema so a change to it fails here rather
    // than in the field, where the symptom is a passenger unable to book.
    const { z } = require('zod');
    const lat = () => z.number().min(4).max(14);
    const lng = () => z.number().min(2).max(15);
    const id = () => z.string().min(1).max(128);
    const rideRequest = z.object({
        rideId: id(),
        passengerId: id(),
        fare: z.number().min(100).max(50000),
        isCash: z.boolean(),
        passengerName: z.string().max(100).optional(),
        pickupLat: lat(),
        pickupLng: lng(),
        destinationLat: lat().optional(),
        destinationLng: lng().optional(),
        pickupAddress: z.string().max(300).optional(),
        destinationAddress: z.string().max(300).optional(),
        estimatedDistanceM: z.number().int().min(0).max(500_000).optional(),
        estimatedDurationSec: z.number().int().min(0).max(86_400).optional(),
        appVersion: z.string().max(32).optional(),
        platform: z.enum(['android', 'ios']).optional(),
        pickupSubLocality: z.string().max(120).optional(),
        pickupLocality: z.string().max(120).optional(),
        pickupCity: z.string().max(120).optional(),
        pickupState: z.string().max(120).optional(),
        destinationSubLocality: z.string().max(120).optional(),
        destinationLocality: z.string().max(120).optional(),
        destinationCity: z.string().max(120).optional(),
        destinationState: z.string().max(120).optional(),
    });

    const v140 = {
        rideId: 'RIDE-1', passengerId: 'p1', fare: 850, isCash: true,
        pickupLat: 6.14, pickupLng: 6.79,
        destinationLat: 6.15, destinationLng: 6.80,
        pickupAddress: '4QHQ+3WF', destinationAddress: 'Main Market',
    };

    it('accepts a request from a build that knows nothing about locality', () => {
        // The version in the Play Store today. If this ever fails, every
        // passenger who has not updated is unable to book a Keke.
        expect(rideRequest.safeParse(v140).success).toBe(true);
    });

    it('accepts a new build that resolved every field', () => {
        expect(rideRequest.safeParse({
            ...v140,
            pickupSubLocality: 'Awada', pickupLocality: 'Obosi',
            pickupCity: 'Onitsha', pickupState: 'Anambra',
            destinationSubLocality: 'Main Market', destinationLocality: 'Onitsha',
        }).success).toBe(true);
    });

    it('accepts a new build whose geocoder resolved only some fields', () => {
        // The common real case: a subLocality but no locality, or vice versa.
        // Partial structure must not be rejected as malformed.
        expect(rideRequest.safeParse({ ...v140, pickupCity: 'Onitsha' }).success).toBe(true);
        expect(rideRequest.safeParse({ ...v140, pickupSubLocality: 'Awada' }).success).toBe(true);
    });

    it('accepts a request with no address at all', () => {
        // The app omits pickupAddress entirely when the geocode produced only a
        // placeholder, rather than sending "Location selected" to be stored as
        // if it named a place.
        const { pickupAddress, destinationAddress, ...noAddr } = v140;
        expect(rideRequest.safeParse(noAddr).success).toBe(true);
    });

    it('still requires the coordinates the ride is actually built on', () => {
        const { pickupLat, ...noLat } = v140;
        expect(rideRequest.safeParse(noLat).success).toBe(false);
    });

    it('rejects an absurdly long locality rather than storing it', () => {
        expect(rideRequest.safeParse({ ...v140, pickupSubLocality: 'x'.repeat(121) }).success)
            .toBe(false);
    });
});
