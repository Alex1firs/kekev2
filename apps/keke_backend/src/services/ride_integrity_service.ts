import { redis } from "../config/redis";

/**
 * Ride integrity / anti-fraud helpers.
 *
 * The backend already stores each driver's live GPS in the `drivers:locations`
 * Redis geoset (updated every ~12s heartbeat), so we can validate a driver's
 * real position at each ride transition WITHOUT trusting the client or needing
 * an app update. These functions are deliberately split into pure evaluators
 * (unit-testable, no I/O) and a thin Redis reader.
 */

const DRIVER_GEO_KEY = "drivers:locations";
const DRIVER_AVAILABILITY_PREFIX = "driver:available:";

export interface LatLng { lat: number; lng: number; }
export interface LiveLocation { lat: number; lng: number; fresh: boolean; }

function envNum(value: string | undefined, fallback: number): number {
    const n = value != null ? Number(value) : NaN;
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Tunable thresholds, overridable via env so ops can adjust without a deploy. */
export const RideIntegrityConfig = {
    get pickupArrivalRadiusM(): number {
        return envNum(process.env.PICKUP_ARRIVAL_RADIUS_METERS, 150);
    },
    get destinationCompletionRadiusM(): number {
        return envNum(process.env.DESTINATION_COMPLETION_RADIUS_METERS, 300);
    },
    get minTripMovementM(): number {
        return envNum(process.env.MIN_TRIP_MOVEMENT_METERS, 100);
    },
    get minTripDurationSec(): number {
        return envNum(process.env.MIN_TRIP_DURATION_SECONDS, 60);
    },
};

/** Great-circle distance in metres between two coordinates. */
export function haversineMeters(a: LatLng, b: LatLng): number {
    const R = 6371000;
    const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const lat1 = toRad(a.lat);
    const lat2 = toRad(b.lat);
    const h =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Read the driver's last-known position from Redis. `fresh` reflects whether a
 * heartbeat has landed recently (the availability key has a 45s TTL). geopos
 * itself has no TTL, so a position may be returned even when `fresh` is false.
 */
export async function getDriverLiveLocation(driverId: string): Promise<LiveLocation | null> {
    try {
        const pos = (await redis.geopos(DRIVER_GEO_KEY, driverId)) as ([string, string] | null)[] | null;
        if (!pos || !pos[0]) return null;
        const lng = Number(pos[0][0]);
        const lat = Number(pos[0][1]);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
        const fresh = (await redis.exists(`${DRIVER_AVAILABILITY_PREFIX}${driverId}`)) === 1;
        return { lat, lng, fresh };
    } catch {
        return null;
    }
}

export type GateOutcome = "ok" | "no_location" | "stale_out_of_range" | "far";

export interface ProximityGate {
    /** Reject the transition outright (only when we have a CONFIDENT out-of-range fix). */
    block: boolean;
    /** Suspicious — allow the transition but mark the ride for review. */
    flagged: boolean;
    outcome: GateOutcome;
    distanceM: number | null;
    driverLoc: LatLng | null;
}

/**
 * Gate for `arrived` / `start`: the driver must be within `radiusM` of the
 * target (pickup). Policy:
 *  - within radius        → ok
 *  - fresh fix, too far   → BLOCK (confident fraud/mistake)
 *  - stale fix, too far   → allow + flag (don't strand a legit ride on GPS drift)
 *  - no fix at all        → allow + flag
 *  - no target coords     → allow, no flag (can't validate)
 */
export function evaluateProximityGate(
    live: LiveLocation | null,
    target: LatLng | null,
    radiusM: number,
): ProximityGate {
    if (!target || !Number.isFinite(target.lat) || !Number.isFinite(target.lng)) {
        return { block: false, flagged: false, outcome: "ok", distanceM: null, driverLoc: live ? { lat: live.lat, lng: live.lng } : null };
    }
    if (!live) {
        return { block: false, flagged: true, outcome: "no_location", distanceM: null, driverLoc: null };
    }
    const driverLoc = { lat: live.lat, lng: live.lng };
    const distanceM = haversineMeters(driverLoc, target);
    if (distanceM <= radiusM) {
        return { block: false, flagged: false, outcome: "ok", distanceM, driverLoc };
    }
    if (!live.fresh) {
        return { block: false, flagged: true, outcome: "stale_out_of_range", distanceM, driverLoc };
    }
    return { block: true, flagged: true, outcome: "far", distanceM, driverLoc };
}

export interface CompletionInput {
    startLoc: LatLng | null;
    endLive: LiveLocation | null;
    destination: LatLng | null;
    startedAt: Date | null;
    now: Date;
    /**
     * The passenger consented to ending the trip early (tapped "End Trip Here"
     * or confirmed the driver's request). When true, `ended_far_from_destination`
     * no longer holds the payment — but movement / duration / GPS-confidence
     * holds are unaffected.
     */
    passengerConsentedEnd?: boolean;
}

export interface CompletionResult {
    endLoc: LatLng | null;
    endDestinationDistanceM: number | null;
    movementDistanceM: number | null;
    durationSec: number | null;
    /** Any anomaly, including soft ones (e.g. stale GPS) — used to flag for review. */
    suspicious: boolean;
    reasons: string[];
    /** Only HARD anomalies hold the money. Stale-GPS alone flags but still settles. */
    holdPayment: boolean;
}

/**
 * Validate a trip at completion. Computes destination proximity, movement
 * (start→end straight-line), and duration, and decides whether the payment
 * must be held for admin review.
 */
export function evaluateCompletion(input: CompletionInput): CompletionResult {
    const cfg = RideIntegrityConfig;
    const reasons: string[] = [];
    const endLoc = input.endLive ? { lat: input.endLive.lat, lng: input.endLive.lng } : null;

    let endDestinationDistanceM: number | null = null;
    if (endLoc && input.destination && Number.isFinite(input.destination.lat) && Number.isFinite(input.destination.lng)) {
        endDestinationDistanceM = haversineMeters(endLoc, input.destination);
        if (endDestinationDistanceM > cfg.destinationCompletionRadiusM) reasons.push("ended_far_from_destination");
    }

    let movementDistanceM: number | null = null;
    if (input.startLoc && endLoc) {
        movementDistanceM = haversineMeters(input.startLoc, endLoc);
        if (movementDistanceM < cfg.minTripMovementM) reasons.push("no_meaningful_movement");
    }

    let durationSec: number | null = null;
    if (input.startedAt) {
        durationSec = Math.max(0, Math.round((input.now.getTime() - input.startedAt.getTime()) / 1000));
        if (durationSec < cfg.minTripDurationSec) reasons.push("trip_too_short");
    }

    // Confidence signals
    if (!input.endLive) reasons.push("no_driver_location_at_completion");
    else if (!input.endLive.fresh) reasons.push("stale_gps_at_completion");

    // Hard reasons move money to review. A stale-GPS fix on its own only flags.
    // Passenger consent additionally forgives ONLY ended_far_from_destination —
    // it never forgives no_meaningful_movement, trip_too_short, or a missing fix.
    const hardReasons = reasons.filter((r) => {
        if (r === "stale_gps_at_completion") return false;
        if (r === "ended_far_from_destination" && input.passengerConsentedEnd) return false;
        return true;
    });
    return {
        endLoc,
        endDestinationDistanceM,
        movementDistanceM,
        durationSec,
        suspicious: reasons.length > 0,
        reasons,
        holdPayment: hardReasons.length > 0,
    };
}

/** Merge a new reason into an existing comma-separated suspiciousReason string. */
export function mergeReasons(existing: string | null | undefined, add: string[]): string {
    const set = new Set<string>();
    if (existing) existing.split(",").map((s) => s.trim()).filter(Boolean).forEach((s) => set.add(s));
    add.forEach((s) => s && set.add(s));
    return Array.from(set).join(",");
}
