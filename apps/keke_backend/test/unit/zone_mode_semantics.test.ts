/**
 * Each mode must do what it claims, on every path.
 *
 * This suite exists because the first implementation did not. `observe` was
 * consulted in exactly zero places on the dispatch side: the dispatch port
 * passed the zone code only when `constrain` was true, so observe collapsed
 * silently into off. Phase 2 would have run for a week and measured nothing,
 * and I would then have recommended enforcement on the strength of a gate that
 * could not move.
 *
 * The defect was invisible because every individual test passed. What was
 * missing was a test of the CONTRACT — that off, observe and enforce are three
 * distinct behaviours rather than two.
 */
import { ServiceZonePolicy, ZoneCoverage } from '../../src/services/service_zone_policy';
import { ServiceZoneService } from '../../src/services/service_zone_service';
import { ServiceZoneStatus, ZoneEnforcement } from '../../src/models/ServiceZone';
import { boundingBox, LatLng } from '../../src/services/service_zone_geometry';
import golden from '../fixtures/service_zone_golden.json';

function zone(code: string, status: ServiceZoneStatus, enforcement: ZoneEnforcement) {
    const spec = (golden.zones as any[]).find((z) => z.code === code)!;
    const polygon = spec.polygon.map((p: number[]) => [p[0], p[1]] as LatLng);
    return {
        code, name: spec.name, polygon, box: boundingBox(polygon),
        bufferMeters: spec.bufferMeters, priority: spec.priority,
        status, enforcement, radiusTiersKm: null,
    };
}

/** Stand in for the database so the modes can be driven directly. */
function withZones(...zones: ReturnType<typeof zone>[]) {
    jest.spyOn(ServiceZoneService, 'operationalZones')
        .mockResolvedValue(zones.filter((z) => z.status === ServiceZoneStatus.ACTIVE) as any);
}

afterEach(() => jest.restoreAllMocks());

describe('coverage is three-valued, and undefined never means allowed', () => {
    beforeEach(() => withZones(
        zone('ONI', ServiceZoneStatus.ACTIVE, ZoneEnforcement.OFF),
        zone('AWK', ServiceZoneStatus.DRAFT, ZoneEnforcement.OFF),
    ));

    it('a ride in an active zone is IN_ZONE', async () => {
        const p = await ServiceZonePolicy.forRide('ONI', 'exact');
        expect(p.coverage).toBe(ZoneCoverage.IN_ZONE);
        expect(p.zoneCode).toBe('ONI');
    });

    it('a ride that resolved OUTSIDE is OUT_OF_COVERAGE, not unresolved', async () => {
        // The Kano case. This is the distinction whose absence let the Kano
        // ride pass the Operations guard without the guard evaluating.
        const p = await ServiceZonePolicy.forRide(null, 'none');
        expect(p.coverage).toBe(ZoneCoverage.OUT_OF_COVERAGE);
        expect(ServiceZonePolicy.refusalReason(p))
            .toBe('pickup is outside every operational service area');
    });

    it('a ride that never resolved is UNRESOLVED and inert', async () => {
        // A ride from before service zones existed, or one created during a
        // resolver fault. Refusing these would punish people for our outage.
        for (const mk of [null, undefined, '']) {
            const p = await ServiceZonePolicy.forRide(null, mk as any);
            expect(p.coverage).toBe(ZoneCoverage.UNRESOLVED);
            expect(p.constrain).toBe(false);
            expect(p.observe).toBe(false);
            expect(ServiceZonePolicy.refusalReason(p)).toBeNull();
        }
    });

    it('a ride classified into a DRAFT zone is OUT_OF_COVERAGE, not in zone', async () => {
        /*
         * The Awka invariant, at the policy layer. A ride may carry
         * zoneCode 'AWK' from classification, but AWK is draft — drawn
         * geography, not a service area. It must not become operational
         * because the polygon exists.
         */
        const p = await ServiceZonePolicy.forRide('AWK', 'exact');
        expect(p.coverage).toBe(ZoneCoverage.OUT_OF_COVERAGE);
        expect(p.zoneCode).toBe('AWK');
        expect(ServiceZonePolicy.refusalReason(p))
            .toBe('pickup is in AWK, which is not an operational service area');
    });
});

describe('the three modes are three distinct behaviours', () => {
    const cases: Array<[ZoneEnforcement, boolean, boolean]> = [
        //                              constrain  observe
        [ZoneEnforcement.OFF, false, false],
        [ZoneEnforcement.OBSERVE, false, true],
        [ZoneEnforcement.ENFORCE, true, false],
    ];

    it.each(cases)('IN_ZONE ride under %s → constrain=%s observe=%s',
        async (mode, constrain, observe) => {
            withZones(zone('ONI', ServiceZoneStatus.ACTIVE, mode));
            const p = await ServiceZonePolicy.forRide('ONI', 'exact');
            expect(p.constrain).toBe(constrain);
            expect(p.observe).toBe(observe);
            expect(ServiceZonePolicy.active(p)).toBe(constrain || observe);
        });

    it.each(cases)('OUT_OF_COVERAGE ride under global %s → constrain=%s observe=%s',
        async (mode, constrain, observe) => {
            withZones(zone('ONI', ServiceZoneStatus.ACTIVE, mode));
            const p = await ServiceZonePolicy.forRide(null, 'none');
            expect(p.constrain).toBe(constrain);
            expect(p.observe).toBe(observe);
        });

    it('OBSERVE is genuinely distinct from OFF — the regression this suite exists for', async () => {
        withZones(zone('ONI', ServiceZoneStatus.ACTIVE, ZoneEnforcement.OFF));
        const off = await ServiceZonePolicy.forRide('ONI', 'exact');

        withZones(zone('ONI', ServiceZoneStatus.ACTIVE, ZoneEnforcement.OBSERVE));
        const obs = await ServiceZonePolicy.forRide('ONI', 'exact');

        expect(ServiceZonePolicy.active(off)).toBe(false);
        expect(ServiceZonePolicy.active(obs)).toBe(true);
        // If these ever match again, observe has collapsed into off and Phase 2
        // measures nothing. That is the failure this whole suite is guarding.
        expect(ServiceZonePolicy.active(off)).not.toBe(ServiceZonePolicy.active(obs));
    });

    it('OBSERVE never constrains, whatever the coverage', async () => {
        withZones(zone('ONI', ServiceZoneStatus.ACTIVE, ZoneEnforcement.OBSERVE));
        for (const [code, mk] of [['ONI', 'exact'], [null, 'none'], [null, null], ['AWK', 'exact']]) {
            const p = await ServiceZonePolicy.forRide(code as any, mk as any);
            expect(p.constrain).toBe(false);
        }
    });
});

describe('the global posture governs rides that belong to no zone', () => {
    it('is the strongest mode among active zones', async () => {
        withZones(
            zone('ONI', ServiceZoneStatus.ACTIVE, ZoneEnforcement.OFF),
            zone('AWK', ServiceZoneStatus.ACTIVE, ZoneEnforcement.ENFORCE),
        );
        expect(await ServiceZonePolicy.globalPosture()).toBe(ZoneEnforcement.ENFORCE);
    });

    it('observe beats off', async () => {
        withZones(
            zone('ONI', ServiceZoneStatus.ACTIVE, ZoneEnforcement.OBSERVE),
            zone('AWK', ServiceZoneStatus.ACTIVE, ZoneEnforcement.OFF),
        );
        expect(await ServiceZonePolicy.globalPosture()).toBe(ZoneEnforcement.OBSERVE);
    });

    it('is "unknown" — and therefore inert — when no zone is active', async () => {
        withZones(zone('AWK', ServiceZoneStatus.DRAFT, ZoneEnforcement.OFF));
        expect(await ServiceZonePolicy.globalPosture()).toBe('unknown');
        const p = await ServiceZonePolicy.forRide(null, 'none');
        expect(p.constrain).toBe(false);
    });

    it('a draft zone cannot raise the posture', async () => {
        // Activating enforcement on a drafted city must be impossible by
        // accident: draft zones are not in the operational set at all.
        withZones(
            zone('ONI', ServiceZoneStatus.ACTIVE, ZoneEnforcement.OFF),
            zone('AWK', ServiceZoneStatus.DRAFT, ZoneEnforcement.ENFORCE),
        );
        expect(await ServiceZonePolicy.globalPosture()).toBe(ZoneEnforcement.OFF);
    });
});

describe('failure policy', () => {
    it('a zone-load failure is inert, never blocking', async () => {
        jest.spyOn(ServiceZoneService, 'operationalZones')
            .mockRejectedValue(new Error('db down'));
        for (const [code, mk] of [['ONI', 'exact'], [null, 'none']]) {
            const p = await ServiceZonePolicy.forRide(code as any, mk as any);
            expect(p.constrain).toBe(false);
            expect(p.observe).toBe(false);
        }
        expect(await ServiceZonePolicy.globalPosture()).toBe('unknown');
    });

    it('the global kill switch makes every policy inert', async () => {
        withZones(zone('ONI', ServiceZoneStatus.ACTIVE, ZoneEnforcement.ENFORCE));
        const prev = process.env.SERVICE_ZONES_ENABLED;
        process.env.SERVICE_ZONES_ENABLED = 'false';
        try {
            const p = await ServiceZonePolicy.forRide('ONI', 'exact');
            expect(p.constrain).toBe(false);
            expect(p.coverage).toBe(ZoneCoverage.UNRESOLVED);
        } finally {
            if (prev === undefined) delete process.env.SERVICE_ZONES_ENABLED;
            else process.env.SERVICE_ZONES_ENABLED = prev;
        }
    });
});
