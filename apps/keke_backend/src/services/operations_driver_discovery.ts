/**
 * The driver list a dispatcher sees when a passenger is stranded.
 *
 * ── Why not GEORADIUS ────────────────────────────────────────────────────
 * The obvious implementation — a radius query against `drivers:locations` —
 * cannot answer the question this screen exists for. A driver who goes offline
 * is zrem'd out of that index, so a geo query returns "0 drivers near Awada"
 * at exactly the moment a dispatcher needs to know there are six, and that
 * Emeka was 700 m away four minutes ago.
 *
 * So this enumerates the approved population and decorates it, reusing the
 * presence semantics AdminService.getLiveDrivers already established. The
 * population grows with drivers recruited, not with rides taken.
 *
 * ── Eligibility is never guessed ─────────────────────────────────────────
 * Assignability comes from DriverEligibilityService — the same call automatic
 * dispatch makes — not from a local reading of `status`. A driver shown as
 * assignable here is one dispatch would also accept, and the reason a driver
 * is NOT assignable is displayed rather than the driver being hidden: "Emeka,
 * ★, 600 m, online, cannot assign: already on active ride" is more useful to a
 * dispatcher than Emeka being absent.
 */
import { In } from 'typeorm';
import { AppDataSource } from '../config/data_source';
import { DriverProfile, DriverStatus } from '../models/DriverProfile';
import { User } from '../models/User';
import { Ride, RideStatus } from '../models/Ride';
import { DispatchService } from './dispatch_service';
import { DriverEligibilityService } from './driver_eligibility_service';
import { OperationsDispatchService } from './operations_dispatch_service';
import { maskName, maskPhone } from './dispatch_monitor_query_service';
import { redis } from '../config/redis';
import { resolveAgainst } from './service_zone_resolver';
import { ServiceZoneService } from './service_zone_service';
import { ServiceZonePolicy, ZoneCoverage } from './service_zone_policy';

/** Presence, strongest first. Mirrors AdminService.getLiveDrivers. */
export type DriverPresenceState =
    | 'ONLINE'
    | 'ON_TRIP'
    | 'RECENTLY_SEEN'
    | 'STALE_HEARTBEAT'
    | 'OFFLINE'
    | 'NEVER_SEEN';

export type DriverCategory = 'ONLINE' | 'NEARBY' | 'FAVOURITE' | 'AT_PARK' | 'OFFLINE' | 'BUSY' | 'ALL';

export interface DiscoveredDriver {
    driverId: string;
    name: string;
    phoneMasked: string | null;
    vehiclePlate: string | null;
    vehicleModel: string | null;
    presence: DriverPresenceState;
    lastSeenSeconds: number | null;

    /** Straight-line km from pickup. Null when no position is known at all. */
    distanceKm: number | null;
    /**
     * TRUE when `distanceKm` came from a stored last-known position rather
     * than live GPS. The UI must label it; a 40-minute-old fix is a hint about
     * who to ring, not a statement of where anyone is.
     */
    distanceIsLastKnown: boolean;

    /**
     * The operational zone this driver's LIVE position resolves to, and whether
     * it matches the ride's.
     *
     * Shown, never used to hide anybody. This screen exists so a dispatcher can
     * see the whole picture — it already displays "cannot assign: already on
     * active ride" rather than dropping that driver — and a driver who silently
     * disappeared from the list would simply be rung on the phone instead.
     * Assignment itself is refused server-side.
     */
    zoneCode: string | null;
    inRideZone: boolean | null;
    /** Human name of `zoneCode` — "Onitsha", "Awka". Null when there is none. */
    zoneName: string | null;
    /**
     * What we actually know about this driver's geography, as one word.
     *
     *   in_zone   live fix, inside an operational zone (`zoneName` names it)
     *   outside   live fix, inside none of them
     *   stale     no live fix — we do NOT know where this driver is
     *
     * `stale` exists so the console cannot present a last-known position as
     * current geography. A 40-minute-old fix is a hint about whose phone to
     * ring, and the screen must say so rather than printing a city name.
     */
    zoneState: 'in_zone' | 'outside' | 'stale';
    /** Ready-to-render label for `zoneState`. Server-side so a third city needs no console release. */
    zoneLabel: string;
    lastKnownAgeSeconds: number | null;

    assignable: boolean;
    /** Why not, in the eligibility service's own vocabulary. */
    ineligibleReason: string | null;
    ineligibleExplanation: string | null;

    activeRideId: string | null;
    parkId: string | null;
    favourite: boolean;
}

const FAVOURITES_KEY = 'ops:favourite_drivers';

/** Earth radius in km. */
function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
    const R = 6371;
    const dLat = ((bLat - aLat) * Math.PI) / 180;
    const dLng = ((bLng - aLng) * Math.PI) / 180;
    const s =
        Math.sin(dLat / 2) ** 2 +
        Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
}

export class OperationsDriverDiscovery {
    /** Operations favourites. A ranking convenience, never a permission. */
    static async favourites(): Promise<Set<string>> {
        try {
            return new Set(await redis.smembers(FAVOURITES_KEY));
        } catch {
            return new Set();
        }
    }

    static async setFavourite(driverId: string, on: boolean): Promise<void> {
        if (on) await redis.sadd(FAVOURITES_KEY, driverId);
        else await redis.srem(FAVOURITES_KEY, driverId);
    }

    /**
     * Candidates for one ride, most useful first.
     *
     * Ordering encodes what a dispatcher actually does: take the nearest
     * driver who can be sent right now; failing that, the nearest one worth
     * ringing. So assignable-and-online sorts above everything, then distance,
     * with favourites breaking ties rather than jumping the queue.
     */
    static async forRide(
        rideId: string,
        opts: { category?: DriverCategory; limit?: number } = {},
    ): Promise<{
        pickup: { lat: number; lng: number } | null;
        rideCoverage: string | null;
        /** The ride's own city, for the header of the picker. */
        rideZone: {
            code: string | null;
            name: string | null;
            label: string;
            /**
             * The ride's zone is ENFORCING, so a cross-zone assignment will be
             * refused by the server.
             *
             * The console reads this to disable the Assign button rather than
             * merely warning — a button that is offered and then rejected
             * teaches an operator that the screen is unreliable. It is false
             * under observe, where the server genuinely does allow the
             * assignment and the UI must not invent a restriction the platform
             * has not made.
             */
            enforced: boolean;
        } | null;
        drivers: DiscoveredDriver[];
    }> {
        const limit = Math.min(Math.max(opts.limit ?? 40, 1), 200);
        const ride = await AppDataSource.getRepository(Ride).findOne({ where: { rideId } });
        if (!ride) return { pickup: null, rideCoverage: null, rideZone: null, drivers: [] };

        const pLat = Number(ride.pickupLat);
        const pLng = Number(ride.pickupLng);
        const pickup =
            Number.isFinite(pLat) && Number.isFinite(pLng) ? { lat: pLat, lng: pLng } : null;

        const profiles = await AppDataSource.getRepository(DriverProfile).find({
            where: { status: DriverStatus.APPROVED },
        });
        if (profiles.length === 0) return { pickup, rideCoverage: null, rideZone: null, drivers: [] };
        const ids = profiles.map((p) => p.userId);

        const [users, activeRides, favourites, lastPositions] = await Promise.all([
            AppDataSource.getRepository(User).find({ where: { id: In(ids) } }),
            AppDataSource.getRepository(Ride).find({
                where: {
                    driverId: In(ids),
                    status: In([
                        RideStatus.ACCEPTED,
                        RideStatus.ARRIVED,
                        RideStatus.IN_PROGRESS,
                        RideStatus.STARTED,
                    ]),
                },
            }),
            this.favourites(),
            DispatchService.lastKnownPositions(ids),
        ]);

        const userById = new Map(users.map((u) => [u.id, u]));
        const rideByDriver = new Map(activeRides.map((r) => [r.driverId, r]));

        // Live presence, batched exactly as the Live Riders view does it.
        const now = Date.now();
        const TTL_MS = DispatchService.AVAILABILITY_TTL_SECONDS * 1000;
        let avail: (string | null)[] = [];
        let lastSeen: (string | null)[] = [];
        let offline: (string | null)[] = [];
        let geos: any[] = [];
        try {
            [avail, lastSeen, offline] = await Promise.all([
                redis.mget(...ids.map((id) => `driver:available:${id}`)),
                redis.mget(...ids.map((id) => `driver:lastseen:${id}`)),
                redis.mget(...ids.map((id) => `driver:offline:${id}`)),
            ]);
            const pipe = redis.pipeline();
            ids.forEach((id) => pipe.geopos('drivers:locations', id));
            const res = (await pipe.exec()) as Array<[Error | null, any]>;
            geos = res.map((r) => r?.[1]);
        } catch (err: any) {
            // Redis down: everyone reports OFFLINE with no distance rather than
            // the request failing. A degraded list beats no list when a
            // passenger is waiting.
            console.warn(`[OPS_DISCOVERY] presence lookup failed: ${err?.message}`);
            avail = ids.map(() => null);
            lastSeen = ids.map(() => null);
            offline = ids.map(() => null);
            geos = ids.map(() => null);
        }

        // ONE eligibility call for the whole population, using the same rules
        // dispatch uses. Never re-derived locally.
        const eligibility = await DriverEligibilityService.filter(ids, {
            isCash: ride.paymentMode === 'cash',
        }).catch(() => ({ eligible: [] as string[], rejected: [] as Array<{ driverId: string; reason: string }> }));
        const eligibleSet = new Set(eligibility.eligible);
        const reasonById = new Map(eligibility.rejected.map((r) => [r.driverId, r.reason]));

        /*
         * Zone labelling. Loaded once for the whole list; a failure leaves every
         * driver unlabelled rather than removing anyone, because this screen's
         * job is to show the dispatcher everything.
         */
        const zoneSet = await ServiceZoneService.operationalZones().catch(() => []);
        const zoneNames = new Map(zoneSet.map((z) => [z.code, z.name]));
        const rideZoneCode: string | null = (ride as any)?.zoneCode ?? null;
        /*
         * The ride's own coverage, so a dispatcher can be told the difference
         * between "this driver is in the wrong city" and "this ride is outside
         * every service area, so nobody is in the right one".
         *
         * Without it, an out-of-coverage ride showed `inRideZone: null` against
         * every driver — indistinguishable from "we did not check". That is the
         * same null-means-nothing gap that let the Kano ride be assigned.
         */
        const ridePolicy = await ServiceZonePolicy.forRide(
            rideZoneCode, (ride as any)?.zoneMatchKind ?? null,
        ).catch(() => null);
        const rideCoverage = ridePolicy?.coverage ?? null;
        const outOfCoverage = rideCoverage === ZoneCoverage.OUT_OF_COVERAGE;

        const drivers: DiscoveredDriver[] = profiles.map((p, i) => {
            const fresh = avail[i] === 'true';
            const seenMs = lastSeen[i] ? Number(lastSeen[i]) : null;
            const ageMs = seenMs != null ? now - seenMs : null;
            const wentOffline = !!offline[i];
            const activeRide = rideByDriver.get(p.userId) ?? null;

            let presence: DriverPresenceState;
            if (fresh) presence = activeRide ? 'ON_TRIP' : 'ONLINE';
            else if (wentOffline) presence = 'OFFLINE';
            else if (ageMs != null && ageMs < 5 * 60_000) presence = 'RECENTLY_SEEN';
            else if (ageMs != null && ageMs < 15 * 60_000) presence = 'STALE_HEARTBEAT';
            else if (ageMs != null) presence = 'OFFLINE';
            else presence = 'NEVER_SEEN';

            /*
             * Live GEO first; last-known only as a labelled fallback.
             *
             * `fresh` is part of the test, and has to be: `drivers:locations`
             * has no TTL, so a GEO entry can outlive the driver's shift by
             * hours. Reading the coordinate alone once made this screen label a
             * driver "Awka" on a fix from the previous evening.
             *
             * The availability key is the honest signal, and it is a structural
             * one rather than a convention: updateDriverLocation writes the GEO
             * entry and the 45-second key in the SAME pipeline, so a live key
             * proves the coordinate behind it is under 45 seconds old. This is
             * the identical rule DriverZoneEligibility applies to dispatch —
             * the picker must not be more credulous than the dispatcher.
             */
            const pair = Array.isArray(geos[i]) ? geos[i][0] : null;
            const liveLng = pair ? parseFloat(pair[0]) : NaN;
            const liveLat = pair ? parseFloat(pair[1]) : NaN;
            const hasLive = fresh && Number.isFinite(liveLat) && Number.isFinite(liveLng);
            const stored = lastPositions.get(p.userId) ?? null;

            let distanceKm: number | null = null;
            let distanceIsLastKnown = false;
            let lastKnownAgeSeconds: number | null = null;
            if (pickup && hasLive) {
                distanceKm = haversineKm(pickup.lat, pickup.lng, liveLat, liveLng);
            } else if (pickup && stored) {
                distanceKm = haversineKm(pickup.lat, pickup.lng, stored.lat, stored.lng);
                distanceIsLastKnown = true;
                lastKnownAgeSeconds = stored.at ? Math.round((now - stored.at) / 1000) : null;
            }

            // Live position only. A driver we cannot locate has no zone — which
            // is different from being in the wrong one, and is shown as such.
            let zoneCode: string | null = null;
            if (hasLive && zoneSet.length > 0) {
                const r = resolveAgainst({ lat: liveLat, lng: liveLng }, zoneSet);
                if (r.kind === 'inside') zoneCode = r.zoneCode;
            }
            /*
             * false — not null — when the ride is out of coverage: no driver can
             * be in a zone the ride does not belong to, and saying "unknown"
             * would understate it. Null remains reserved for "we could not tell".
             */
            const inRideZone = outOfCoverage ? false
                : (rideZoneCode ? zoneCode === rideZoneCode : null);

            /*
             * Three states, not two. "Outside every service area" and "we have
             * no current fix for this driver" look identical if both render as
             * a blank cell, and they are opposite situations: the first is a
             * fact about the driver, the second is an absence of facts.
             */
            const zoneState: 'in_zone' | 'outside' | 'stale' =
                !hasLive ? 'stale' : (zoneCode ? 'in_zone' : 'outside');
            const zoneName = zoneCode ? zoneNames.get(zoneCode) ?? zoneCode : null;
            const zoneLabel = zoneState === 'stale' ? 'Location stale'
                : zoneState === 'outside' ? 'Outside service areas'
                : zoneName!;

            const assignable = eligibleSet.has(p.userId);
            const reason = assignable ? null : reasonById.get(p.userId) ?? 'not_available';

            return {
                driverId: p.userId,
                name: maskName(p.firstName, p.lastName),
                phoneMasked: maskPhone(userById.get(p.userId)?.phone),
                vehiclePlate: p.vehiclePlate ?? null,
                vehicleModel: p.vehicleModel ?? null,
                presence,
                lastSeenSeconds: ageMs != null ? Math.round(ageMs / 1000) : null,
                distanceKm: distanceKm != null ? Number(distanceKm.toFixed(2)) : null,
                distanceIsLastKnown,
                lastKnownAgeSeconds,
                zoneCode,
                inRideZone,
                zoneName,
                zoneState,
                zoneLabel,
                assignable,
                ineligibleReason: reason,
                ineligibleExplanation: reason
                    ? OperationsDispatchService.explainIneligibility(reason)
                    : null,
                activeRideId: activeRide?.rideId ?? null,
                parkId: p.homeParkId ?? null,
                favourite: favourites.has(p.userId),
            };
        });

        const filtered = drivers.filter((d) => this.matchesCategory(d, opts.category ?? 'ALL'));
        filtered.sort((a, b) => {
            // Who can be sent RIGHT NOW comes first.
            const aReady = a.assignable && (a.presence === 'ONLINE') ? 0 : 1;
            const bReady = b.assignable && (b.presence === 'ONLINE') ? 0 : 1;
            if (aReady !== bReady) return aReady - bReady;
            // Then a live distance beats a stale one at the same range.
            if (a.distanceIsLastKnown !== b.distanceIsLastKnown) {
                return a.distanceIsLastKnown ? 1 : -1;
            }
            const ad = a.distanceKm ?? Infinity;
            const bd = b.distanceKm ?? Infinity;
            if (ad !== bd) return ad - bd;
            // Favourites break ties. They never jump the queue.
            if (a.favourite !== b.favourite) return a.favourite ? -1 : 1;
            return a.name.localeCompare(b.name);
        });

        /*
         * The picker's own header. A dispatcher choosing a driver must be able
         * to see which city they are choosing FOR — otherwise every driver row
         * below is a label without a question.
         */
        const rideZoneName = rideZoneCode ? zoneNames.get(rideZoneCode) ?? null : null;
        const rideZone = {
            code: rideZoneCode,
            name: rideZoneName,
            label: outOfCoverage
                ? 'Outside every service area'
                : (rideZoneName ?? (rideZoneCode ?? 'Zone not determined')),
            enforced: ridePolicy?.constrain === true,
        };

        return { pickup, rideCoverage, rideZone, drivers: filtered.slice(0, limit) };
    }

    private static matchesCategory(d: DiscoveredDriver, c: DriverCategory): boolean {
        switch (c) {
            case 'ONLINE':
                return d.presence === 'ONLINE';
            case 'NEARBY':
                return d.distanceKm != null && d.distanceKm <= 5;
            case 'FAVOURITE':
                return d.favourite;
            case 'AT_PARK':
                return d.parkId != null;
            case 'OFFLINE':
                return ['OFFLINE', 'RECENTLY_SEEN', 'STALE_HEARTBEAT', 'NEVER_SEEN'].includes(d.presence);
            case 'BUSY':
                return d.presence === 'ON_TRIP' || d.activeRideId != null;
            case 'ALL':
            default:
                return true;
        }
    }
}
