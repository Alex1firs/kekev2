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

/** Statuses that mean a driver is mid-ride and must not be offered another. */
export const DRIVER_BUSY_RIDE_STATES = ['accepted', 'arrived', 'in_progress'] as const;

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

    return { eligible, rejected };
  }
}
