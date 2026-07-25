/**
 * Test harness for the multi-round dispatch orchestrator.
 *
 * The orchestrator's ports are faked so round logic can be exercised with no
 * socket.io, Postgres or FCM — but driver reservations deliberately go through
 * the REAL DispatchService against the mocked Redis, so the atomic SET NX
 * behaviour under test is the production code path.
 *
 * Time is virtual: `sleep` advances a fake clock instead of waiting, so a
 * two-round dispatch with 15s offer windows completes in microseconds.
 */
import {
  DispatchOrchestrator,
  DispatchPorts,
  DispatchRun,
  EligibilityResult,
  NearbyCandidate,
  OfferDelivery,
} from '../../src/services/dispatch_orchestrator';
import { DispatchConfig, loadDispatchConfig } from '../../src/config/dispatch_config';
import { DispatchService } from '../../src/services/dispatch_service';
import { setHeartbeatFresh } from './dispatch';

export interface FakeDriver {
  driverId: string;
  distanceKm?: number;
  /** Radius (km) from which this driver becomes discoverable. */
  withinKm?: number;
  /** Eligibility failure reason; when set the driver never reaches reservation. */
  ineligibleReason?: string;
  /** Fresh heartbeat. False → skipped as stale immediately before the offer. */
  available?: boolean;
  /** Delivery behaviour for this driver's offers. */
  delivery?: Partial<OfferDelivery>;
  /** Round from which the driver exists at all (simulates coming online later). */
  onlineFromRound?: number;
}

export interface LoggedEvent {
  event: string;
  fields: Record<string, any>;
}

export class OrchestratorHarness {
  readonly config: DispatchConfig;
  readonly logs: LoggedEvent[] = [];
  readonly rideEvents: Array<{ event: string; payload: Record<string, unknown> }> = [];
  readonly offers: Array<{
    driverId: string;
    round: number;
    at: number;
    reservationOwnerAtOffer: string | null;
  }> = [];
  readonly rideId: string;

  drivers: FakeDriver[] = [];
  rideStatus: string | null = 'searching';
  assigned = false;

  /** Virtual clock, advanced only by sleep(). */
  private clock = 1_700_000_000_000;
  private currentRound = 1;

  /** Hooks fired when the clock passes a given elapsed-ms mark. */
  private readonly scheduled: Array<{ atElapsed: number; fn: (h: OrchestratorHarness) => void; fired: boolean }> = [];
  private readonly offerReactions: Array<{
    driverId: string;
    afterMs: number;
    fn: (h: OrchestratorHarness) => void;
    armed: boolean;
  }> = [];
  private readonly roundReactions: Array<{
    round: number;
    afterMs: number;
    fn: (h: OrchestratorHarness) => void;
    armed: boolean;
  }> = [];
  private readonly startedAt = this.clock;

  readonly orchestrator: DispatchOrchestrator;
  readonly run: DispatchRun;

  constructor(rideId: string, overrides: Partial<DispatchConfig> = {}) {
    this.rideId = rideId;
    this.config = { ...loadDispatchConfig(), ...overrides };
    this.orchestrator = new DispatchOrchestrator(this.ports(), this.config);
    this.run = this.orchestrator.createRun(rideId);
  }

  get now(): number {
    return this.clock;
  }

  get elapsed(): number {
    return this.clock - this.startedAt;
  }

  /** Run `fn` once the virtual clock has advanced past `atElapsed` ms. */
  at(atElapsed: number, fn: (h: OrchestratorHarness) => void): this {
    this.scheduled.push({ atElapsed, fn, fired: false });
    return this;
  }

  /**
   * React `afterMs` of virtual time after `driverId` is offered the ride — the
   * deterministic way to model a driver answering, since it runs on the virtual
   * clock rather than racing the orchestrator on the real timer queue.
   *
   * Firing on a LATER clock slice also matters for ordering: the orchestrator
   * records offer_sent and opens the offer window immediately after sendOffer
   * returns, so a reaction dispatched inside sendOffer would be overwritten.
   */
  reactToOffer(driverId: string, afterMs: number, fn: (h: OrchestratorHarness) => void): this {
    this.offerReactions.push({ driverId, afterMs, fn, armed: false });
    return this;
  }

  /** React `afterMs` of virtual time after the given round is announced. */
  reactToRound(round: number, afterMs: number, fn: (h: OrchestratorHarness) => void): this {
    this.roundReactions.push({ round, afterMs, fn, armed: false });
    return this;
  }

  private fireScheduled(): void {
    for (const s of this.scheduled) {
      if (!s.fired && this.elapsed >= s.atElapsed) {
        s.fired = true;
        s.fn(this);
      }
    }
  }

  /** Make every configured driver's heartbeat fresh in the mock Redis. */
  async primeHeartbeats(): Promise<void> {
    for (const d of this.drivers) {
      if (d.available !== false) await setHeartbeatFresh(d.driverId);
    }
  }

  eventsNamed(name: string): LoggedEvent[] {
    return this.logs.filter((l) => l.event === name);
  }

  rideEventsNamed(name: string): Array<Record<string, unknown>> {
    return this.rideEvents.filter((e) => e.event === name).map((e) => e.payload);
  }

  offersTo(driverId: string): Array<{ round: number; at: number }> {
    return this.offers.filter((o) => o.driverId === driverId).map(({ round, at }) => ({ round, at }));
  }

  private ports(): DispatchPorts {
    return {
      findNearby: async (_lat, _lng, radiusKm, limit): Promise<NearbyCandidate[]> => {
        return this.drivers
          .filter((d) => (d.onlineFromRound ?? 1) <= this.currentRound)
          .filter((d) => (d.withinKm ?? 0) <= radiusKm)
          .slice(0, limit)
          .map((d) => ({ driverId: d.driverId, distanceKm: d.distanceKm ?? d.withinKm ?? 1 }));
      },

      filterEligible: async (driverIds: string[]): Promise<EligibilityResult> => {
        const eligible: string[] = [];
        const rejected: Array<{ driverId: string; reason: string }> = [];
        for (const id of driverIds) {
          const d = this.drivers.find((x) => x.driverId === id);
          if (d?.ineligibleReason) rejected.push({ driverId: id, reason: d.ineligibleReason });
          else eligible.push(id);
        }
        return { eligible, rejected };
      },

      isDriverAvailable: async (driverId: string) => {
        const d = this.drivers.find((x) => x.driverId === driverId);
        return d?.available !== false;
      },

      getRideStatus: async () => this.rideStatus,
      isRideAssigned: async () => this.assigned,

      sendOffer: async (driverId: string, round: number): Promise<OfferDelivery> => {
        this.currentRound = round;
        // Who owned the reservation at the instant of the offer. Lets a test
        // assert that no ride ever offers a driver it does not hold.
        const reservationOwnerAtOffer = await DispatchService.getReservationOwner(driverId);
        this.offers.push({ driverId, round, at: this.clock, reservationOwnerAtOffer });
        // Arm any driver reaction on the virtual clock.
        for (const r of this.offerReactions) {
          if (!r.armed && r.driverId === driverId) {
            r.armed = true;
            this.at(this.elapsed + r.afterMs, r.fn);
          }
        }
        const d = this.drivers.find((x) => x.driverId === driverId);
        const base: OfferDelivery = { delivered: true, socketDelivered: true, pushSuccessCount: 1 };
        return { ...base, ...(d?.delivery ?? {}) };
      },

      emitToRide: (_rideId, event, payload) => {
        if (event === 'ride:dispatch_round') {
          const round = Number(payload.dispatchRound ?? this.currentRound);
          this.currentRound = round;
          for (const r of this.roundReactions) {
            if (!r.armed && r.round === round) {
              r.armed = true;
              this.at(this.elapsed + r.afterMs, r.fn);
            }
          }
        }
        this.rideEvents.push({ event, payload });
      },

      log: (event, fields) => {
        this.logs.push({ event, fields });
        if (event === 'round_start') this.currentRound = Number(fields.round);
      },

      now: () => this.clock,

      sleep: async (ms: number) => {
        // Virtual time: step forward in slices so scheduled hooks (a driver
        // coming online, a passenger cancelling) land mid-wait like they would
        // in reality. An abort mid-wait ends the sleep immediately.
        const slices = 10;
        const step = Math.max(1, Math.floor(ms / slices));
        let advanced = 0;
        while (advanced < ms) {
          if (this.run.isAborted) return;
          const delta = Math.min(step, ms - advanced);
          this.clock += delta;
          advanced += delta;
          this.fireScheduled();
          // Yield a MACROTASK, not just a microtask: tests react to offers via
          // real timers (setInterval), and those only run once the macrotask
          // queue gets a turn. `await Promise.resolve()` would starve them.
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      },
    };
  }
}
