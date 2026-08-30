/**
 * A draft zone must never become dispatchable.
 *
 * Twenty of the 972 historical rides were requested in Awka and must be
 * classified as AWK — that is what they are. But Awka is not open, and the
 * migration needing its geometry must not be the thing that makes it live.
 *
 * The obvious implementation is one resolver with an `includeDraft` flag. This
 * suite exists because that is exactly what was avoided: there are two
 * functions, with different names, returning different types, drawing from
 * different zone sets, in different files — and these tests assert the
 * separation holds at the level of the source tree, not just the intention.
 */
import fs from 'fs';
import path from 'path';
import { resolveAgainst } from '../../src/services/service_zone_resolver';
import { LoadedZone } from '../../src/services/service_zone_service';
import {
    ServiceZoneStatus, ZoneEnforcement, OPERATIONAL_STATUSES, CLASSIFIABLE_STATUSES,
} from '../../src/models/ServiceZone';
import { boundingBox, LatLng } from '../../src/services/service_zone_geometry';
import fixture from '../fixtures/service_zone_golden.json';

const SRC = path.join(__dirname, '..', '..', 'src');

function zone(code: string, status: ServiceZoneStatus): LoadedZone {
    const spec = (fixture.zones as any[]).find((z) => z.code === code)!;
    const polygon = spec.polygon.map((p: number[]) => [p[0], p[1]] as LatLng);
    return {
        code, name: spec.name, polygon, box: boundingBox(polygon),
        bufferMeters: spec.bufferMeters, priority: spec.priority,
        status, enforcement: ZoneEnforcement.OFF, radiusTiersKm: null,
    };
}

/** A coordinate in central Awka. One of the 20 real historical pickups. */
const AWKA_POINT = { lat: 6.21090, lng: 7.07400 };
const ONITSHA_POINT = { lat: 6.1667, lng: 6.7833 };

describe('status semantics', () => {
    it('the runtime zone set is `active` and nothing else', () => {
        expect(OPERATIONAL_STATUSES).toEqual([ServiceZoneStatus.ACTIVE]);
        expect(OPERATIONAL_STATUSES).not.toContain(ServiceZoneStatus.DRAFT);
        expect(OPERATIONAL_STATUSES).not.toContain(ServiceZoneStatus.PAUSED);
    });

    it('the classification zone set includes drafts, and never retired zones', () => {
        expect(CLASSIFIABLE_STATUSES).toContain(ServiceZoneStatus.DRAFT);
        expect(CLASSIFIABLE_STATUSES).toContain(ServiceZoneStatus.ACTIVE);
        expect(CLASSIFIABLE_STATUSES).not.toContain(ServiceZoneStatus.RETIRED);
    });
});

describe('an Awka coordinate during Phase 1', () => {
    // Phase 1 shipping state: ONI active, AWK draft.
    const runtimeZones = [zone('ONI', ServiceZoneStatus.ACTIVE)];
    const classifyZones = [zone('ONI', ServiceZoneStatus.ACTIVE), zone('AWK', ServiceZoneStatus.DRAFT)];

    it('classifies as AWK for backfill', () => {
        const r = resolveAgainst(AWKA_POINT, classifyZones);
        expect(r.kind).toBe('inside');
        if (r.kind === 'inside') expect(r.zoneCode).toBe('AWK');
    });

    it('does NOT resolve to AWK at runtime — the draft zone is not there to find', () => {
        const r = resolveAgainst(AWKA_POINT, runtimeZones);
        expect(r.kind).toBe('outside');
        if (r.kind === 'outside') expect(r.nearestZoneCode).toBe('ONI');
    });

    it('never places an Awka pickup into Onitsha', () => {
        // The failure that would matter most: a draft zone being invisible must
        // not mean the point falls into the nearest OPERATING zone instead.
        const r = resolveAgainst(AWKA_POINT, runtimeZones);
        expect(r.kind).not.toBe('inside');
    });

    it('leaves Onitsha resolving exactly as it does with one zone', () => {
        const withDraft = resolveAgainst(ONITSHA_POINT, classifyZones);
        const without = resolveAgainst(ONITSHA_POINT, runtimeZones);
        expect(withDraft).toEqual(without);
    });

    it('AWK cannot be an operational candidate until it is activated', () => {
        // The activation itself, simulated: the same point, the same code path,
        // a different status on the row.
        const activated = [zone('ONI', ServiceZoneStatus.ACTIVE), zone('AWK', ServiceZoneStatus.ACTIVE)];
        const before = resolveAgainst(AWKA_POINT, runtimeZones);
        const after = resolveAgainst(AWKA_POINT, activated);
        expect(before.kind).toBe('outside');
        expect(after.kind).toBe('inside');
        if (after.kind === 'inside') expect(after.zoneCode).toBe('AWK');
    });
});

describe('the separation is structural, not a convention', () => {
    /**
     * The classifier sees draft geometry. If a dispatch path could import it,
     * every guarantee above becomes a matter of whoever writes the next feature
     * remembering. So this walks the source tree.
     */
    /**
     * An IMPORT, not a mention. The resolver and the zone service both refer to
     * the classifier in prose — pointing a reader at the separation is the
     * opposite of violating it — so matching bare text would fail on its own
     * documentation and teach whoever hit it to delete the comment.
     */
    const imports = (src: string): boolean =>
        /^\s*(?:import\b[^;]*|const\b[^=]*=\s*require\s*\()[^;]*service_zone_classifier/m.test(src)
        || /^\s*import\s*\{[^}]*\bZoneClassifier\b/m.test(src);

    const FORBIDDEN_IMPORTERS = [
        'sockets/socket_handler.ts',
        'services/dispatch_orchestrator.ts',
        'services/dispatch_service.ts',
        'services/driver_eligibility_service.ts',
        'services/driver_candidate_service.ts',
        'services/operations_dispatch_service.ts',
        'services/operations_driver_discovery.ts',
        'services/nearby_keke_feed_service.ts',
        'services/park_dispatch_service.ts',
        'services/park_selection_service.ts',
    ];

    it.each(FORBIDDEN_IMPORTERS)('%s does not import the classifier', (rel) => {
        const file = path.join(SRC, rel);
        if (!fs.existsSync(file)) return;           // file moved; nothing to assert
        const source = fs.readFileSync(file, 'utf8');
        expect(imports(source)).toBe(false);
    });

    it('only migrations and reporting import the classifier', () => {
        const offenders: string[] = [];
        const walk = (dir: string) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) { walk(full); continue; }
                if (!entry.name.endsWith('.ts')) continue;
                if (full.endsWith('service_zone_classifier.ts')) continue;
                const src = fs.readFileSync(full, 'utf8');
                if (!imports(src)) continue;
                const rel = path.relative(SRC, full);
                const allowed = rel.startsWith('migrations') || rel.startsWith('scripts')
                    || rel.includes('report');
                if (!allowed) offenders.push(rel);
            }
        };
        walk(SRC);
        expect(offenders).toEqual([]);
    });

    it('the runtime resolver exposes no way to ask for draft zones', () => {
        const src = fs.readFileSync(path.join(SRC, 'services/service_zone_resolver.ts'), 'utf8');
        // No flag, no option, no status parameter reaching the runtime path.
        expect(src).not.toMatch(/includeDraft/i);
        expect(src).not.toMatch(/CLASSIFIABLE_STATUSES/);
        expect(src).not.toMatch(/classifiableZones/);
    });

    it('the zone-set loaders are separate methods, not one parameterised method', () => {
        const src = fs.readFileSync(path.join(SRC, 'services/service_zone_service.ts'), 'utf8');
        expect(src).toMatch(/static async operationalZones\(\): Promise/);
        expect(src).toMatch(/static async classifiableZones\(\): Promise/);
        // operationalZones takes no arguments — nothing to pass that widens it.
        expect(src).not.toMatch(/operationalZones\((?!\)).*\)/);
    });
});
