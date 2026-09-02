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
import { ZonePolicy, ServiceZonePolicy, logWouldRejectCandidate } from './service_zone_policy';

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
   * The geographic policy for this ride.
   *
   * Absent means "no geographic work at all" — which is what every caller
   * passes while enforcement is OFF, so the legacy path is not merely
   * equivalent but literally the same code making the same round trips. That
   * is what makes the parity claim literal rather than approximate.
   *
   * ── The three modes, and why observe is safe ─────────────────────────
   *   off      not passed. Nothing is computed.
   *   observe  evaluated, logged, and DISCARDED. `eligible` and `rejected`
   *            come back byte-identical to what they would be with no policy
   *            at all — the observation travels in `zoneObservations`, which
   *            no dispatch code reads. Observation cannot remove a driver
   *            because it never touches the arrays that decide.
   *   enforce  evaluated and applied: `outside_ride_zone` in `rejected`.
   *
   * ── The rejection is REPORTED, never silently applied ────────────────
   * Under enforce the reason lands in `rejected` and the caller decides. The
   * five callers need three behaviours: dispatch and assignment EXCLUDE, the
   * passenger marker feed EXCLUDES, and Operations driver discovery must LABEL
   * and never hide — a dispatcher who cannot see why a driver disappeared will
   * ring them anyway.
   */
  zonePolicy?: ZonePolicy;

  /** Ride id, for the observation log lines. Diagnostics only. */
  rideId?: string;
}

export interface EligibilityOutcome {
  eligible: string[];
  rejected: Array<{ driverId: string; reason: string }>;
  /**
   * What enforcement WOULD have rejected, in observe mode.
   *
   * Populated only under `observe`, and read by nothing in the dispatch path —
   * that is the whole point. It exists so tests and the log can prove the
   * constraint was evaluated, while `eligible` and `rejected` stay identical to
   * the off-mode result. If observation ever needs to affect a decision it will
   * have to be moved out of this field deliberately, which is a change somebody
   * has to make on purpose rather than by accident.
   */
  zoneObservations?: Array<{ driverId: string; reason: string; driverZone: string | null }>;
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

    /*
     * Geographic eligibility. Last, because it is the only check needing a
     * Redis round trip, and by here the list is as short as it will get.
     *
     * Skipped entirely when no policy is supplied, or when the policy asks for
     * nothing — so OFF costs not one extra call.
     */
    const policy = ctx.zonePolicy;
    if (eligible.length > 0 && policy && ServiceZonePolicy.active(policy)) {
      const outside = await this.outsideZone(eligible, policy);

      if (policy.constrain) {
        eligible = eligible.filter((id) => {
          if (!outside.has(id)) return true;
          rejected.push({ driverId: id, reason: 'outside_ride_zone' });
          return false;
        });
      }

      if (outside.size > 0) {
        const observations = [...outside.entries()].map(([driverId, driverZone]) => ({
          driverId, reason: 'outside_ride_zone', driverZone,
        }));
        for (const o of observations) {
          logWouldRejectCandidate({
            rideId: ctx.rideId ?? 'unknown',
            driverId: o.driverId,
            rideZone: policy.zoneCode,
            driverZone: o.driverZone,
            mode: String(policy.mode),
            applied: policy.constrain,
          });
        }
        // Under OBSERVE this is the ONLY trace. `eligible` and `rejected` are
        // untouched above, so the dispatch outcome is identical to off.
        if (policy.observe) return { eligible, rejected, zoneObservations: observations };
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
    driverIds: string[], policy: ZonePolicy,
  ): Promise<Map<string, string | null>> {
    // Driver id -> the zone they ARE in (null when outside every zone), so the
    // observation can say where they were rather than only that they failed.
    const out = new Map<string, string | null>();
    try {
      const zones = await ServiceZoneService.operationalZones();
      const positions = await DispatchService.livePositions(driverIds);
      for (const id of driverIds) {
        const p = positions.get(id);
        if (!p) continue;                       // unknown position, not "elsewhere"
        const r = resolveAgainst(p, zones);
        if (r.kind === 'error') continue;       // a fault is not evidence of location
        const driverZone = r.kind === 'inside' ? r.zoneCode : null;
        /*
         * A ride with NO zone — outside every service area — can be matched by
         * nobody. Under enforce every driver is "outside" it, which is correct:
         * there is no zone to be inside. This is the null-zone gap closed at
         * the eligibility layer as well as the assignment layer.
         */
        if (policy.zoneCode && driverZone === policy.zoneCode) continue;
        out.set(id, driverZone);
      }
    } catch (err: any) {
      // Cannot evaluate: constrain nothing. The alternative — excluding
      // everybody — would take a city off the road because Redis blinked.
      console.warn(JSON.stringify({
        level: 'warn', scope: 'service_zone', event: 'eligibility_zone_check_failed',
        zoneCode: policy.zoneCode, coverage: policy.coverage, error: err?.message ?? 'unknown',
      }));
      return new Map();
    }
    return out;
  }
}
