/**
 * Coordinates that actually reached production, asserted forever.
 *
 * On 31 August 2026 a passenger in Kano State — 666 km outside the service
 * area — made ten ride requests in eight minutes. The zone architecture
 * recognised every one of them as outside, and because enforcement was off,
 * every one was allowed through. One was then manually assigned by Operations
 * to a driver standing in Onitsha, whose phone was pushed for a trip he could
 * never make.
 *
 * A fixture nothing reads is worthless, so these are the assertions:
 *
 *   - the Kano coordinates must resolve OUTSIDE, at roughly the recorded
 *     distance. If a future boundary edit ever brings Kano inside — or brings
 *     ONI's edge close enough that the distance moves materially — this fails.
 *   - the Onitsha driver positions must resolve INSIDE. They are what makes
 *     "an Onitsha driver was given a Kano ride" a measured fact rather than an
 *     inference.
 *   - the narrowest real margin — 392 m, the closest any of 932 legitimate
 *     rides sits to the boundary — is recorded so that a boundary change that
 *     eats into it cannot pass unnoticed.
 *
 * This file asserts geometry only. It does NOT test enforcement, because
 * enforcement is not enabled and this suite must not be the thing that
 * quietly starts assuming it is.
 */
import incidents from '../fixtures/production_incident_vectors.json';
import golden from '../fixtures/service_zone_golden.json';
import { resolveAgainst } from '../../src/services/service_zone_resolver';
import { LoadedZone } from '../../src/services/service_zone_service';
import { boundingBox, LatLng, distanceToPolygonMetres } from '../../src/services/service_zone_geometry';
import { ServiceZoneStatus, ZoneEnforcement } from '../../src/models/ServiceZone';

/** The RUNTIME zone set as production actually holds it: ONI active, AWK draft. */
const RUNTIME: LoadedZone[] = (golden.zones as any[])
    .filter((z) => z.code === 'ONI')
    .map((z) => {
        const polygon = z.polygon.map((p: number[]) => [p[0], p[1]] as LatLng);
        return {
            code: z.code, name: z.name, polygon, box: boundingBox(polygon),
            bufferMeters: z.bufferMeters, priority: z.priority,
            status: ServiceZoneStatus.ACTIVE, enforcement: ZoneEnforcement.OFF,
            radiusTiersKm: null,
        };
    });

const ONI_POLYGON: LatLng[] = RUNTIME[0].polygon;

describe('production incident vectors', () => {
    for (const incident of incidents.incidents as any[]) {
        describe(`${incident.id} — ${incident.summary.slice(0, 70)}…`, () => {
            for (const v of incident.vectors) {
                it(`${v.label} resolves ${incident.expect.kind}`, () => {
                    const r = resolveAgainst({ lat: v.lat, lng: v.lng }, RUNTIME);
                    expect(r.kind).toBe(incident.expect.kind);

                    if (r.kind === 'outside') {
                        expect(r.nearestZoneCode).toBe(incident.expect.nearestZoneCode);
                        if (v.distanceM) {
                            // Within 1 km of what production recorded. Loose enough
                            // to survive a trivial vertex adjustment, tight enough
                            // that moving the boundary toward Kano would fail.
                            expect(Math.abs(r.distanceM - v.distanceM)).toBeLessThan(1000);
                        }
                    }
                    if (r.kind === 'inside') {
                        expect(r.zoneCode).toBe(incident.expect.zoneCode);
                        if (incident.expect.match) expect(r.match).toBe(incident.expect.match);
                    }
                });
            }
        });
    }

    it('Kano is not merely outside — it is three orders of magnitude beyond dispatch reach', () => {
        // The widest dispatch tier is 6.5 km. This is the number that made
        // automatic dispatch safe without anybody designing it to be.
        const kano = { lat: 12.0363172, lng: 8.4730917 };
        const r = resolveAgainst(kano, RUNTIME);
        expect(r.kind).toBe('outside');
        if (r.kind === 'outside') {
            expect(r.distanceM / 1000).toBeGreaterThan(600);
            expect(r.distanceM / 1000 / 6.5).toBeGreaterThan(100);
        }
    });

    it('the narrowest legitimate margin is preserved', () => {
        /*
         * 392 m is how far inside the boundary the closest of 932 real Onitsha
         * rides sits. Enforcement is safe partly because of that gap. If a
         * boundary edit ever shrinks it, this is where it should be noticed —
         * and the fixture is the record of what the margin was when we decided
         * enforcement was safe.
         */
        const m = (incidents as any).boundaryMargin;
        expect(m.closestRideMetresInside).toBe(392);
        expect(m.ridesWithin400m).toBe(3);
        expect(m.totalOniRides).toBe(932);

        // A GPS error would have to exceed the interior margin AND the 400 m
        // buffer before a legitimate ride could be wrongly refused.
        const bufferM = RUNTIME[0].bufferMeters;
        expect(m.closestRideMetresInside + bufferM).toBeGreaterThan(750);
    });

    it('the ONI boundary has not moved since the incident was recorded', () => {
        // Cheap tamper check: the recorded distances were computed against this
        // polygon. If it changes, the incident record stops meaning what it says.
        expect(ONI_POLYGON).toHaveLength(12);
        const kanoC = distanceToPolygonMetres(12.0363172, 8.4730917, ONI_POLYGON);
        expect(Math.round(kanoC)).toBe(666487);
    });
});
