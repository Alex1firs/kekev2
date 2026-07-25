/**
 * The passenger's nearby-Keke map feed: strictly read-only, and assembled from
 * the same rules dispatch uses.
 *
 * Pipeline, in order:
 *   1. discovery      — Redis GEO within the ride's LIVE search radius, already
 *                       heartbeat- and location-filtered (an intentionally
 *                       offline driver is removed from the geo index outright)
 *   2. eligibility    — DriverEligibilityService, the same call dispatch makes
 *   3. reservation    — drop drivers another ride is currently holding
 *   4. privacy        — NearbyMarkerService anonymises and approximates
 *
 * It reserves nothing, offers nothing and mutates nothing.
 *
 * On the internal distinction the passenger must NOT be able to make:
 *   (1) nearby+eligible  → the only stage this feed exposes, and anonymously
 *   (2) selected candidate, (3) reserved, (4) offer sent, (5) assigned
 *       → dispatch-evidence stages, never leaked here. A marker therefore never
 *         implies the driver was offered this ride.
 */
import { DispatchService } from './dispatch_service';
import { DriverEligibilityService } from './driver_eligibility_service';
import { NearbyMarkerService, MarkerFeed } from './nearby_marker_service';
import { loadDispatchConfig } from '../config/dispatch_config';

export interface SearchingFeed extends MarkerFeed {
  rideId: string;
  dispatchRound: number;
  searchRadiusKm: number;
  /** When eligibility was evaluated, so the client can age the data out. */
  evaluatedAt: number;
}

export class NearbyKekeFeedService {
  /**
   * Marker feed for a ride that is currently searching.
   *
   * The search area comes from the orchestrator's published context, so round
   * two's wider radius is reflected automatically. If no context has been
   * published yet (the very first moments of a request) it falls back to the
   * ride's own pickup point and the first configured tier — never to a wider
   * area than dispatch would use.
   */
  static async forSearchingRide(ride: {
    rideId: string;
    pickupLat: number;
    pickupLng: number;
    paymentMode?: string | null;
  }): Promise<SearchingFeed> {
    const now = Date.now();
    const context = await DispatchService.getSearchContext(ride.rideId);
    const config = loadDispatchConfig();

    const radiusKm = context?.radiusKm ?? config.radiusTiersKm[0] ?? 2;
    const dispatchRound = context?.dispatchRound ?? 1;
    const lat = context?.lat ?? ride.pickupLat;
    const lng = context?.lng ?? ride.pickupLng;

    // 1. Discovery — nearest-first, heartbeat-fresh, within the live radius.
    //    Ask for a little more than we will show so eligibility filtering does
    //    not leave the map emptier than the real supply.
    const discovered = await DispatchService.getNearbyActiveDriversWithLocations(
      lat,
      lng,
      radiusKm,
      Math.max(config.candidateLimit, NearbyMarkerService.MAX_MARKERS * 2),
    );

    if (discovered.length === 0) {
      // No eligible supply → an empty feed. Never padded or simulated.
      return {
        ...NearbyMarkerService.buildFeed([], { scopeId: ride.rideId, now }),
        rideId: ride.rideId,
        dispatchRound,
        searchRadiusKm: radiusKm,
        evaluatedAt: now,
      };
    }

    // 2. Eligibility — identical rules to dispatch. No `excluded` set is passed:
    //    filtering out drivers who declined this ride would leak their response.
    const { eligible } = await DriverEligibilityService.filter(
      discovered.map((d) => d.driverId),
      { isCash: ride.paymentMode === 'cash' },
    );
    const eligibleSet = new Set(eligible);

    // 3. Reservation — a driver held by ANOTHER ride is not available to this
    //    passenger, so showing them would be overstating supply. Drivers held by
    //    THIS ride stay: they are genuinely nearby and eligible, and since
    //    markers are anonymous, capped and unordered, their presence reveals
    //    nothing about who was offered anything.
    const unreserved = new Set(
      await DispatchService.filterUnreserved(
        discovered.map((d) => d.driverId),
        ride.rideId,
      ),
    );

    const usable = discovered.filter((d) => eligibleSet.has(d.driverId) && unreserved.has(d.driverId));

    // 4. Privacy transform.
    return {
      ...NearbyMarkerService.buildFeed(usable, { scopeId: ride.rideId, now }),
      rideId: ride.rideId,
      dispatchRound,
      searchRadiusKm: radiusKm,
      evaluatedAt: now,
    };
  }

  /**
   * Marker feed for the browse/idle map, before any ride exists.
   *
   * Same eligibility and privacy treatment — a passenger who has not requested
   * yet must not be shown suspended, busy or reserved drivers as available
   * supply either. Scoped to the viewer so marker keys are not comparable
   * between users.
   */
  static async forBrowsing(args: {
    viewerId: string;
    lat: number;
    lng: number;
    radiusKm: number;
  }): Promise<MarkerFeed> {
    const now = Date.now();
    const config = loadDispatchConfig();

    const discovered = await DispatchService.getNearbyActiveDriversWithLocations(
      args.lat,
      args.lng,
      args.radiusKm,
      Math.max(config.candidateLimit, NearbyMarkerService.MAX_MARKERS * 2),
    );
    if (discovered.length === 0) {
      return NearbyMarkerService.buildFeed([], { scopeId: args.viewerId, now });
    }

    // No ride yet, so no payment mode: the cash-debt gate cannot be evaluated
    // and is skipped rather than guessed. Every other rule still applies.
    const { eligible } = await DriverEligibilityService.filter(
      discovered.map((d) => d.driverId),
      { isCash: false },
    );
    const eligibleSet = new Set(eligible);

    // Reserved drivers are mid-offer for someone else — not available supply.
    const reservationOwners = await Promise.all(
      discovered.map((d) => DispatchService.getReservationOwner(d.driverId)),
    );
    const usable = discovered.filter((d, i) => eligibleSet.has(d.driverId) && reservationOwners[i] == null);

    return NearbyMarkerService.buildFeed(usable, { scopeId: args.viewerId, now });
  }
}
