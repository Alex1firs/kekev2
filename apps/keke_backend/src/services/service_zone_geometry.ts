/**
 * The arithmetic underneath service zones. Pure functions, no I/O, no state.
 *
 * ── Why this is its own file ────────────────────────────────────────────
 * The boundaries were drawn and approved using a Python implementation of
 * exactly these routines. Production runs TypeScript. The two must agree to
 * the metre or production resolves differently from the map that was approved,
 * so the geometry is isolated here and tested against a frozen vector file
 * generated from the Python — see test/fixtures/service_zone_golden.json.
 *
 * ── Why not PostGIS ─────────────────────────────────────────────────────
 * PostGIS 3.3.4 is present in the database image but not installed. With two
 * polygons of a dozen vertices each, cached in process, resolution is a
 * bounding-box comparison and a ray cast — microseconds, no round trip. Storing
 * GeoJSON now means turning PostGIS on later is an index change rather than a
 * re-modelling, which is the part that would be expensive to get wrong.
 */

/** Metres per degree of latitude. Constant enough at Nigerian latitudes. */
const M_PER_DEG_LAT = 110574;
const M_PER_DEG_LNG_EQUATOR = 111320;

/**
 * A point on or within 0.5 m of a boundary is INSIDE the zone, not inside the
 * tolerance band. Ray casting is genuinely ambiguous exactly on an edge, and
 * without this a pickup on the line would be recorded as buffer-dependent —
 * which would corrupt the one number that tells us whether the boundaries are
 * drawn correctly or are being propped up by the buffer.
 */
export const ON_BOUNDARY_TOLERANCE_M = 0.5;

/** `[lat, lng]`. Deliberately not GeoJSON order — see toGeoJson/fromGeoJson. */
export type LatLng = readonly [number, number];

export interface BoundingBox {
    minLat: number;
    minLng: number;
    maxLat: number;
    maxLng: number;
}

export function isUsablePoint(lat: unknown, lng: unknown): boolean {
    return Number.isFinite(lat as number)
        && Number.isFinite(lng as number)
        && (lat as number) >= -90 && (lat as number) <= 90
        && (lng as number) >= -180 && (lng as number) <= 180
        // 0,0 is the Gulf of Guinea and is what an uninitialised coordinate
        // looks like. Treating it as a real point would resolve it as
        // "outside", which is indistinguishable from a genuine miss.
        && !((lat as number) === 0 && (lng as number) === 0);
}

export function boundingBox(polygon: readonly LatLng[]): BoundingBox {
    let minLat = Infinity, minLng = Infinity, maxLat = -Infinity, maxLng = -Infinity;
    for (const [lat, lng] of polygon) {
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
        if (lng < minLng) minLng = lng;
        if (lng > maxLng) maxLng = lng;
    }
    return { minLat, minLng, maxLat, maxLng };
}

/**
 * Bounding-box test, dilated by `padMetres` so it can prefilter buffer
 * candidates as well as exact ones. Cheap, and discards nearly everything.
 */
export function inBoundingBox(lat: number, lng: number, box: BoundingBox, padMetres = 0): boolean {
    const padLat = padMetres / M_PER_DEG_LAT;
    const cos = Math.cos((lat * Math.PI) / 180);
    const padLng = padMetres / (M_PER_DEG_LNG_EQUATOR * Math.max(cos, 0.01));
    return lat >= box.minLat - padLat && lat <= box.maxLat + padLat
        && lng >= box.minLng - padLng && lng <= box.maxLng + padLng;
}

/**
 * Ray casting. Identical in form to the Python that produced the approved
 * boundaries — including its behaviour on an edge, which is why the
 * on-boundary tolerance above exists rather than being folded in here.
 */
export function pointInPolygon(lat: number, lng: number, polygon: readonly LatLng[]): boolean {
    let inside = false;
    const n = polygon.length;
    for (let i = 0; i < n; i += 1) {
        const [aLat, aLng] = polygon[i];
        const [bLat, bLng] = polygon[(i + 1) % n];
        if ((aLng > lng) !== (bLng > lng)) {
            const t = (lng - aLng) / (bLng - aLng);
            if (lat < aLat + t * (bLat - aLat)) inside = !inside;
        }
    }
    return inside;
}

/**
 * Distance from a point to a segment, via a local equirectangular projection.
 *
 * Exact great-circle distance to a geodesic segment is not worth the cost here:
 * over the hundreds of metres this is asked about, the error is well under a
 * centimetre, and the answer is compared against a 400 m tolerance.
 */
function segmentDistanceMetres(
    lat: number, lng: number, a: LatLng, b: LatLng,
): number {
    const lat0 = ((a[0] + b[0]) / 2) * Math.PI / 180;
    const kx = M_PER_DEG_LNG_EQUATOR * Math.cos(lat0);
    const ky = M_PER_DEG_LAT;

    const px = lng * kx, py = lat * ky;
    const ax = a[1] * kx, ay = a[0] * ky;
    const bx = b[1] * kx, by = b[0] * ky;
    const dx = bx - ax, dy = by - ay;

    if (dx === 0 && dy === 0) return Math.hypot(px - ax, py - ay);
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** 0 when inside; otherwise metres to the nearest edge. */
export function distanceToPolygonMetres(
    lat: number, lng: number, polygon: readonly LatLng[],
): number {
    if (pointInPolygon(lat, lng, polygon)) return 0;
    let best = Infinity;
    for (let i = 0; i < polygon.length; i += 1) {
        const d = segmentDistanceMetres(lat, lng, polygon[i], polygon[(i + 1) % polygon.length]);
        if (d < best) best = d;
    }
    return best;
}

// ── GeoJSON ─────────────────────────────────────────────────────────────
//
// Stored as GeoJSON so the boundary is portable — into PostGIS, into a map
// tool, into a report — without a bespoke format nobody else can read. GeoJSON
// is [lng, lat]; everything above is [lat, lng], which is the order the rest of
// this codebase uses. The conversion lives here so the mistake can only be made
// in one place.

export interface GeoJsonPolygon {
    type: 'Polygon';
    /** Rings; only the outer ring is used. Closed (first point repeated). */
    coordinates: number[][][];
}

export function toGeoJson(polygon: readonly LatLng[]): GeoJsonPolygon {
    const ring = polygon.map(([lat, lng]) => [lng, lat]);
    ring.push([...ring[0]]);       // GeoJSON rings must close
    return { type: 'Polygon', coordinates: [ring] };
}

/** Returns null rather than throwing: a malformed boundary is a resolver error. */
export function fromGeoJson(value: unknown): LatLng[] | null {
    const g = value as GeoJsonPolygon | null;
    if (!g || g.type !== 'Polygon' || !Array.isArray(g.coordinates)) return null;
    const ring = g.coordinates[0];
    if (!Array.isArray(ring) || ring.length < 4) return null;

    const out: LatLng[] = [];
    for (const pair of ring) {
        if (!Array.isArray(pair) || pair.length < 2) return null;
        const [lng, lat] = pair;
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
        out.push([lat, lng] as LatLng);
    }
    // Drop the repeated closing point; every routine here closes implicitly.
    const first = out[0], last = out[out.length - 1];
    if (first[0] === last[0] && first[1] === last[1]) out.pop();
    return out.length >= 3 ? out : null;
}
