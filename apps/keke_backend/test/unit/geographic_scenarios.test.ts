/**
 * Every geographic situation multi-city dispatch has to survive.
 *
 * Waiting for real users to generate each of these would mean discovering the
 * Kano case by telephone — which is exactly how we discovered the Kano case.
 * These are synthesised from the approved boundaries so the whole space is
 * covered before Awka opens rather than after.
 *
 * The coordinate-shaped scenarios live in the fixture. The behavioural ones —
 * stale locations, a driver outside his home zone, GPS drift — are about driver
 * state rather than geometry and are proven in awka_launch_db.test.ts, where
 * there is a real Redis to hold the state.
 */
import scenarios from '../fixtures/geographic_scenarios.json';
import golden from '../fixtures/service_zone_golden.json';
import { resolveAgainst } from '../../src/services/service_zone_resolver';
import { LoadedZone } from '../../src/services/service_zone_service';
import { boundingBox, LatLng } from '../../src/services/service_zone_geometry';
import { ServiceZoneStatus, ZoneEnforcement } from '../../src/models/ServiceZone';

function zones(activeCodes: string[]): LoadedZone[] {
    return (golden.zones as any[])
        .filter((z) => activeCodes.includes(z.code))
        .map((z) => {
            const polygon = z.polygon.map((p: number[]) => [p[0], p[1]] as LatLng);
            return {
                code: z.code, name: z.name, polygon, box: boundingBox(polygon),
                bufferMeters: z.bufferMeters, priority: z.priority,
                status: ServiceZoneStatus.ACTIVE, enforcement: ZoneEnforcement.OFF,
                radiusTiersKm: null,
            };
        });
}

/** Awka launched: both zones operational. */
const BOTH = zones(['ONI', 'AWK']);
/** Production today: Awka still drafted, so invisible to the runtime resolver. */
const ONI_ONLY = zones(['ONI']);

const V = scenarios.vectors as any[];
const by = (s: string) => V.filter((v) => v.scenario === s);

describe('geographic scenarios — both zones operational', () => {
    it.each(V.map((v) => [`${v.scenario}: ${v.label}`, v]))('%s', (_l, v: any) => {
        const r = resolveAgainst({ lat: v.lat, lng: v.lng }, BOTH);
        expect(r.kind).toBe(v.expect.kind);
        if (r.kind === 'inside') {
            expect(r.zoneCode).toBe(v.expect.zoneCode);
            expect(r.match).toBe(v.expect.match);
        } else if (r.kind === 'outside') {
            expect(r.nearestZoneCode).toBe(v.expect.nearestZoneCode);
            expect(Math.abs(r.distanceM - v.expect.distanceM)).toBeLessThanOrEqual(1);
        }
    });
});

describe('the properties each scenario group exists to prove', () => {
    it('every ONI interior point is ONI, exactly', () => {
        for (const v of by('ONI_INTERIOR')) {
            const r = resolveAgainst({ lat: v.lat, lng: v.lng }, BOTH);
            expect(r.kind === 'inside' && r.zoneCode === 'ONI' && r.match === 'exact').toBe(true);
        }
    });

    it('every AWK interior point is AWK, exactly — once AWK is launched', () => {
        for (const v of by('AWK_INTERIOR')) {
            const r = resolveAgainst({ lat: v.lat, lng: v.lng }, BOTH);
            expect(r.kind === 'inside' && r.zoneCode === 'AWK' && r.match === 'exact').toBe(true);
        }
    });

    it('the buffer admits at 250 m and refuses at 600 m, for both zones', () => {
        for (const v of [...by('ONI_BUFFER'), ...by('AWK_BUFFER')]) {
            const r = resolveAgainst({ lat: v.lat, lng: v.lng }, BOTH);
            expect(r.kind).toBe('inside');
            if (r.kind === 'inside') expect(r.match).toBe('buffer');
        }
        for (const v of [...by('ONI_JUST_OUTSIDE_BUFFER'), ...by('AWK_JUST_OUTSIDE_BUFFER')]) {
            const r = resolveAgainst({ lat: v.lat, lng: v.lng }, BOTH);
            expect(r.kind).toBe('outside');
        }
    });

    it('a point on the boundary is inside, never buffer-dependent', () => {
        for (const v of [...by('ONI_BOUNDARY'), ...by('AWK_BOUNDARY')]) {
            const r = resolveAgainst({ lat: v.lat, lng: v.lng }, BOTH);
            expect(r.kind).toBe('inside');
            if (r.kind === 'inside') expect(r.match).toBe('exact');
        }
    });

    it('the corridor between the cities belongs to NEITHER', () => {
        // 16.3 km of open ground. Nobody should be dispatched from here, and no
        // zone should quietly claim it because it happens to be nearer.
        for (const v of by('BETWEEN_ZONES')) {
            const r = resolveAgainst({ lat: v.lat, lng: v.lng }, BOTH);
            expect(r.kind).toBe('outside');
        }
    });

    it('Kano and Lagos are outside by hundreds of kilometres', () => {
        for (const v of [...by('KANO'), ...by('LAGOS')]) {
            const r = resolveAgainst({ lat: v.lat, lng: v.lng }, BOTH);
            expect(r.kind).toBe('outside');
            if (r.kind === 'outside') expect(r.distanceM).toBeGreaterThan(300_000);
        }
    });

    it('Asaba, Nnewi and Atani stay outside — the deliberate exclusions', () => {
        for (const v of [...by('ADJACENT_STATE'), ...by('FUTURE_ZONE'), ...by('HELD_OUTSIDE')]) {
            const r = resolveAgainst({ lat: v.lat, lng: v.lng }, BOTH);
            expect(r.kind).toBe('outside');
        }
    });

    it('no scenario resolves into the WRONG city', () => {
        // The multi-city failure that would matter most.
        for (const v of V) {
            const r = resolveAgainst({ lat: v.lat, lng: v.lng }, BOTH);
            if (r.kind !== 'inside') continue;
            expect(r.zoneCode).toBe(v.expect.zoneCode);
        }
    });
});

describe('while AWK is still draft — production today', () => {
    it('every Awka point resolves OUTSIDE, not into Onitsha', () => {
        // The invariant that keeps a drafted city dormant: invisible to the
        // runtime resolver, and never absorbed by its neighbour.
        for (const v of [...by('AWK_INTERIOR'), ...by('AWK_BOUNDARY'), ...by('AWK_BUFFER')]) {
            const r = resolveAgainst({ lat: v.lat, lng: v.lng }, ONI_ONLY);
            expect(r.kind).toBe('outside');
            if (r.kind === 'outside') expect(r.nearestZoneCode).toBe('ONI');
        }
    });

    it('Onitsha resolves identically whether or not AWK exists', () => {
        for (const v of [...by('ONI_INTERIOR'), ...by('ONI_BOUNDARY')]) {
            const withAwk = resolveAgainst({ lat: v.lat, lng: v.lng }, BOTH);
            const without = resolveAgainst({ lat: v.lat, lng: v.lng }, ONI_ONLY);
            expect(withAwk).toEqual(without);
        }
    });
});

describe('malformed and missing coordinates', () => {
    it.each([
        ['null island (uninitialised)', 0, 0],
        ['NaN latitude', NaN, 6.78],
        ['Infinite longitude', 6.16, Infinity],
        ['latitude out of range', 200, 6.78],
        ['longitude out of range', 6.16, 400],
    ])('%s is an ERROR, never "outside"', (_label, lat, lng) => {
        // Conflating a bad coordinate with a genuine miss would let a data
        // fault masquerade as a product decision to refuse somebody.
        const r = resolveAgainst({ lat: lat as number, lng: lng as number }, BOTH);
        expect(r.kind).toBe('error');
    });

    it('an empty zone set is an error, not a universal refusal', () => {
        const r = resolveAgainst({ lat: 6.1667, lng: 6.7833 }, []);
        expect(r.kind).toBe('error');
    });
});

describe('fixture integrity', () => {
    it('covers every scenario group the launch requires', () => {
        const required = [
            'ONI_INTERIOR', 'ONI_BOUNDARY', 'ONI_BUFFER', 'ONI_JUST_OUTSIDE_BUFFER',
            'AWK_INTERIOR', 'AWK_BOUNDARY', 'AWK_BUFFER', 'AWK_JUST_OUTSIDE_BUFFER',
            'BETWEEN_ZONES', 'KANO', 'LAGOS', 'ADJACENT_STATE', 'FUTURE_ZONE', 'HELD_OUTSIDE',
        ];
        for (const s of required) expect(by(s).length).toBeGreaterThan(0);
        expect(V.length).toBeGreaterThanOrEqual(30);
    });
});
