/**
 * The single definition of "this driver may be dispatched a ride right now".
 *
 * Extracted verbatim from the dispatch orchestrator's eligibility port so that
 * the passenger's nearby-Keke map feed and real dispatch cannot drift apart. If
 * a rule changes it changes here, for both — a marker can never represent supply
 * that dispatch would refuse to use.
 *
 * READ-ONLY: this service filters, it never reserves, offers or assigns.
 */
import { In } from 'typeorm';
import { AppDataSource } from '../config/data_source';
import { Ride } from '../models/Ride';
import { DriverProfile } from '../models/DriverProfile';
import { WalletService } from './wallet_service';
import { DispatchService } from './dispatch_service';
import { resolveAgainst } from './service_zone_resolver';
import { ServiceZoneService } from './service_zone_service';

/** Statuses that mean a driver is mid-ride and must not be offered another. */
/*
 * Ride states in which a driver must not be offered another ride.
 *
 * `started` is included defensively. Nothing persists it today — trip-start
 * writes `in_progress` and only BROADCASTS 'started' to match the passenger
 * UI's expected string — but RideStatus.STARTED exists, several read paths
 * accept it, and if anything ever writes it this exclusion would silently stop
 * working and a driver could be offered a second ride mid-trip. Listing it
 * costs one array entry.
 */
export const DRIVER_BUSY_RIDE_STATES = ['accepted', 'arrived', 'in_progress', 'started'] as const;

export interface EligibilityContext {
  /** Cash rides additionally exclude debt-blocked drivers. */
  isCash: boolean;
  /**
   * Drivers to drop up front — dispatch passes the ride's explicit rejectors.
   *
   * The map feed deliberately passes NOTHING here: filtering the passenger's
   * markers by who declined would leak driver response state, which the
   * passenger must never be able to infer.
   */
  excluded?: ReadonlySet<string>;

  /**
   * The zone this ride belongs to. When present, a driver whose CURRENT
   * position does not resolve to it is reported as `outside_ride_zone`.
   *
   * Optional, and absent means "no geographic constraint" — which is what every
   * caller passes while enforcement is off, so the legacy path is not merely
   * equivalent but literally the same code with the same number of round trips.
   *
   * ── The rejection is REPORTED, never silently applied ────────────────
   * Like every other reason here, this lands in `rejected` and the caller
   * decides what to do with it. That matters because the five callers need
   * three different behaviours: dispatch and assignment EXCLUDE, the passenger
   * marker feed EXCLUDES, and Operations driver discovery must LABEL and never
   * hide — a dispatcher who cannot see why a driver disappeared will ring them
   * anyway.
   */
  rideZoneCode?: string | null;
}

export interface EligibilityOutcome {
  eligible: string[];
  rejected: Array<{ driverId: string; reason: string }>;
}

export class DriverEligibilityService {
  /**
   * Business eligibility for a candidate list, preserving input order (dispatch
   * relies on nearest-first ordering being retained).
   *
   * Deliberately NOT covered here, because the caller owns them:
   *  - heartbeat/location freshness — Redis geo + availability TTL at discovery;
   *  - reservation state — DispatchService.filterUnreserved / reserveDriver.
   */
  static async filter(driverIds: string[], ctx: EligibilityContext): Promise<EligibilityOutcome> {
    const rejected: Array<{ driverId: string; reason: string }> = [];
    let eligible = [...driverIds];
    if (eligible.length === 0) return { eligible, rejected };

    // Explicit per-ride exclusions (dispatch only).
    if (ctx.excluded && ctx.excluded.size > 0) {
      eligible = eligible.filter((id) => {
        if (!ctx.excluded!.has(id)) return true;
        rejected.push({ driverId: id, reason: 'explicit_rejector' });
        return false;
      });
    }

    // Approved only: suspended or rejected drivers must never receive requests,
    // and must never appear as available supply.
    if (eligible.length > 0) {
      const profiles = await AppDataSource.getRepository(DriverProfile).findBy(
        eligible.map((id) => ({ userId: id })),
      );
      const byId = new Map(profiles.map((p) => [p.userId, p]));
      eligible = eligible.filter((id) => {
        const profile = byId.get(id);
        if (!profile) {
          rejected.push({ driverId: id, reason: 'no_driver_profile' });
          return false;
        }
        if (profile.status === 'suspended' || profile.status === 'rejected') {
          rejected.push({ driverId: id, reason: 'driver_suspended_or_rejected' });
          return false;
        }
        return true;
      });
    }

    // Cash rides: strip debt-blocked drivers.
    if (ctx.isCash && eligible.length > 0) {
      const cashOk = new Set(await WalletService.filterCashEligibleDrivers(eligible));
      eligible = eligible.filter((id) => {
        if (cashOk.has(id)) return true;
        rejected.push({ driverId: id, reason: 'cash_debt_blocked' });
        return false;
      });
    }

    // Already on an active ride.
    if (eligible.length > 0) {
      const busy = await AppDataSource.getRepository(Ride).find({
        where: { driverId: In(eligible), status: In(DRIVER_BUSY_RIDE_STATES as unknown as any[]) },
      });
      if (busy.length > 0) {
        const busyIds = new Set(busy.map((r) => r.driverId));
        eligible = eligible.filter((id) => {
          if (!busyIds.has(id)) return true;
          rejected.push({ driverId: id, reason: 'already_on_active_ride' });
          return false;
        });
      }
    }

    // Geographic eligibility. Last, because it is the only check that needs a
    // Redis round trip, and by here the list is as short as it will get.
    if (eligible.length > 0 && ctx.rideZoneCode) {
      const outside = await this.outsideZone(eligible, ctx.rideZoneCode);
      if (outside.size > 0) {
        eligible = eligible.filter((id) => {
          if (!outside.has(id)) return true;
          rejected.push({ driverId: id, reason: 'outside_ride_zone' });
          return false;
        });
      }
    }

    return { eligible, rejected };
  }

  /**
   * Which of these drivers are NOT currently in `zoneCode`.
   *
   * Uses live position only — the same geo entry dispatch already trusts. A
   * driver with no live position is not treated as outside: they are already
   * excluded upstream by the availability filter, and inventing a geographic
   * reason for an absence we cannot measure would put a misleading line in the
   * dispatcher's screen.
   *
   * Reads the presence system; changes nothing about it.
   */
  private static async outsideZone(
    driverIds: string[], zoneCode: string,
  ): Promise<Set<string>> {
    const out = new Set<string>();
    try {
      const zones = await ServiceZoneService.operationalZones();
      const positions = await DispatchService.livePositions(driverIds);
      for (const id of driverIds) {
        const p = positions.get(id);
        if (!p) continue;                       // unknown position, not "elsewhere"
        const r = resolveAgainst(p, zones);
        if (r.kind === 'inside' && r.zoneCode === zoneCode) continue;
        if (r.kind === 'error') continue;       // a fault is not evidence of location
        out.add(id);
      }
    } catch (err: any) {
      // Cannot evaluate: constrain nothing. The alternative — excluding
      // everybody — would take a city off the road because Redis blinked.
      console.warn(JSON.stringify({
        level: 'warn', scope: 'service_zone', event: 'eligibility_zone_check_failed',
        zoneCode, error: err?.message ?? 'unknown',
      }));
      return new Set();
    }
    return out;
  }
}
