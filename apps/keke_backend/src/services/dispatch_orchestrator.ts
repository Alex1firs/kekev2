/**
 * Controlled multi-round dispatch.
 *
 * One ride record, at most [[DispatchConfig.maxRounds]] automatic rounds (capped
 * at two for this release), one atomic reservation system, and a hard overall
 * search-lifetime budget so searching can never run indefinitely.
 *
 * Everything the orchestrator touches outside itself arrives through [[DispatchPorts]],
 * so the whole round machine is unit-testable without socket.io, Postgres or FCM.
 * Driver reservations are the one exception: those go through the real
 * DispatchService so the atomic SET NX behaviour under test is the production one.
 */
import { DispatchService } from './dispatch_service';
import {
  DispatchConfig,
  loadDispatchConfig,
  tiersForRound,
} from '../config/dispatch_config';
import {
  DispatchEvidence,
  DispatchSummary,
  DispatchOutcomeCode,
} from './dispatch_evidence';

/** Outcome of trying to put an offer on a driver's device. */
export interface OfferDelivery {
  /** True when at least one transport confirmed delivery. */
  delivered: boolean;
  /** The driver had a live socket in their room at emit time. */
  socketDelivered: boolean;
  /** Count of push tokens FCM accepted (0 when push was unavailable). */
  pushSuccessCount: number;
  /** Why delivery failed, for the log. */
  reason?: string;
}

export interface EligibilityResult {
  eligible: string[];
  /** driverId → why they were dropped, for the evidence ledger. */
  rejected: Array<{ driverId: string; reason: string }>;
}

export interface NearbyCandidate {
  driverId: string;
  distanceKm: number | null;
}

export type DispatchStopReason =
  | 'accepted'
  | 'cancelled'
  | 'ride_gone'
  | 'assigned_elsewhere'
  | 'lifetime_exceeded'
  | 'rounds_exhausted'
  /**
   * A named dispatcher took control of this ride. NOT a failure: the ride is
   * still searching and a human is actively finding it a driver, so nothing
   * downstream may mark it failed or tell the passenger nobody came.
   */
  | 'operations_control'
  | 'aborted';

export interface DispatchPorts {
  /** Nearest-first candidates from the geo index, heartbeat-filtered. */
  findNearby(lat: number, lng: number, radiusKm: number, limit: number): Promise<NearbyCandidate[]>;
  /** Business eligibility: suspended/rejected, cash debt, already-busy. */
  filterEligible(driverIds: string[]): Promise<EligibilityResult>;
  /** Re-check freshness immediately before offering. */
  isDriverAvailable(driverId: string): Promise<boolean>;
  /** Current ride status, or null when the row is gone. */
  getRideStatus(rideId: string): Promise<string | null>;
  /** Whether some driver already holds this ride. */
  isRideAssigned(rideId: string): Promise<boolean>;
  /**
   * True while Operations holds a live takeover lease on this ride.
   *
   * Checked before every round rather than relying on the abort signal alone,
   * because a takeover can land on a ride whose run this process does not own
   * — after a restart, or on the other colour mid-deploy. Fails OPEN: if this
   * cannot be determined, automatic dispatch continues, because a passenger
   * waiting is worse than a dispatcher being interrupted.
   */
  isDispatchPaused?(rideId: string): Promise<boolean>;
  /** Deliver the offer over socket + push. */
  sendOffer(driverId: string, round: number): Promise<OfferDelivery>;
  /** Realtime event to the ride room (passenger). */
  emitToRide(rideId: string, event: string, payload: Record<string, unknown>): void;
  /** Structured dispatch log line. */
  log(event: string, fields: Record<string, unknown>): void;
  /** Injectable clock. */
  now(): number;
  /** Abortable sleep — resolves early if the run is stopped. */
  sleep(ms: number): Promise<void>;
}

export interface DispatchResult {
  stopReason: DispatchStopReason;
  summary: DispatchSummary;
  outcome: { code: DispatchOutcomeCode; dispatchResult: string } | null;
}

/**
 * Live handle on one ride's dispatch run. The socket handler keeps this so
 * driver rejections, acknowledgements, acceptance and passenger cancellation can
 * feed the same ledger the round loop is reading.
 */
export class DispatchRun {
  readonly rideId: string;
  readonly evidence: DispatchEvidence;
  readonly config: DispatchConfig;
  readonly startedAt: number;

  private aborted = false;
  private abortReason: DispatchStopReason | null = null;
  private wakeups: Array<() => void> = [];
  /** Drivers currently holding an open offer from this ride, by round. */
  private readonly openOffers = new Set<string>();

  constructor(rideId: string, config: DispatchConfig, startedAt: number) {
    this.rideId = rideId;
    this.config = config;
    this.startedAt = startedAt;
    this.evidence = new DispatchEvidence(rideId);
  }

  get isAborted(): boolean {
    return this.aborted;
  }

  get stopReason(): DispatchStopReason | null {
    return this.abortReason;
  }

  /**
   * Stop the run cooperatively. Any in-flight tier wait resolves immediately, so
   * an acceptance or cancellation halts dispatch activity at once instead of
   * letting the current tier run out its offer window.
   */
  abort(reason: DispatchStopReason): void {
    if (this.aborted) return;
    this.aborted = true;
    this.abortReason = reason;
    this.wake();
  }

  /** Wake every pending sleep (used by abort and by early-answer signals). */
  wake(): void {
    const pending = this.wakeups;
    this.wakeups = [];
    for (const resolve of pending) resolve();
  }

  onWake(resolve: () => void): void {
    this.wakeups.push(resolve);
  }

  noteOfferOpen(driverId: string): void {
    this.openOffers.add(driverId);
  }

  closeOffer(driverId: string): void {
    this.openOffers.delete(driverId);
  }

  get openOfferIds(): string[] {
    return [...this.openOffers];
  }

  /** A driver rejected — record it and stop waiting on their offer. */
  noteRejection(driverId: string): void {
    this.evidence.rejected(driverId);
    this.closeOffer(driverId);
    // No open offers left in this tier: stop waiting and widen immediately.
    if (this.openOffers.size === 0) this.wake();
  }

  noteAcknowledgement(driverId: string): void {
    this.evidence.acknowledged(driverId);
  }

  noteAcceptance(driverId: string): void {
    this.evidence.acceptedBy(driverId);
    this.abort('accepted');
  }

  elapsedMs(now: number): number {
    return now - this.startedAt;
  }

  remainingLifetimeMs(now: number): number {
    return Math.max(0, this.config.maxSearchLifetimeMs - this.elapsedMs(now));
  }
}

export class DispatchOrchestrator {
  private readonly ports: DispatchPorts;
  private readonly config: DispatchConfig;

  constructor(ports: DispatchPorts, config: DispatchConfig = loadDispatchConfig()) {
    this.ports = ports;
    this.config = config;
  }

  createRun(rideId: string): DispatchRun {
    return new DispatchRun(rideId, this.config, this.ports.now());
  }

  /**
   * Run every configured round until a driver accepts, the ride stops being
   * dispatchable, or the lifetime budget runs out. Never creates or mutates a
   * ride record — the caller owns ride persistence, so a second round cannot
   * produce a second ride or a second payment reservation.
   */
  async run(
    run: DispatchRun,
    pickup: { lat: number; lng: number },
  ): Promise<DispatchResult> {
    const { rideId, evidence } = run;

    for (let round = 1; round <= this.config.maxRounds; round += 1) {
      const gate = await this.canStartRound(run, round);
      if (!gate.ok) {
        return this.finish(run, gate.reason);
      }

      if (round > 1) {
        // Authoritative round-transition event: the passenger UI switches to the
        // "Still searching nearby…" copy off this, with no new booking request.
        this.ports.log('round_transition', {
          rideId,
          fromRound: round - 1,
          toRound: round,
          elapsedMs: run.elapsedMs(this.ports.now()),
          previousRound: evidence.summary(false).rounds[round - 2],
        });
        this.ports.emitToRide(rideId, 'ride:dispatch_round', {
          rideId,
          dispatchRound: round,
          totalRounds: this.config.maxRounds,
          reason: 'auto_redispatch',
          ...this.publicSummary(evidence.summary(false)),
        });
        await this.ports.sleep(this.config.roundGapMs);
        if (run.isAborted) return this.finish(run, run.stopReason ?? 'aborted');
      }

      const tiers = tiersForRound(this.config, round);
      evidence.beginRound(round, tiers, this.ports.now());
      this.ports.log('round_start', { rideId, round, radiusTiersKm: tiers });

      const roundStop = await this.runRound(run, round, tiers, pickup);
      evidence.endRound(this.ports.now());

      if (roundStop) return this.finish(run, roundStop);
    }

    return this.finish(run, 'rounds_exhausted');
  }

  /**
   * Round-two (and beyond) preconditions. Every one of these must hold, checked
   * against live state rather than remembered state.
   */
  private async canStartRound(
    run: DispatchRun,
    round: number,
  ): Promise<{ ok: true } | { ok: false; reason: DispatchStopReason }> {
    if (run.isAborted) return { ok: false, reason: run.stopReason ?? 'aborted' };

    const status = await this.ports.getRideStatus(run.rideId);
    if (status == null) return { ok: false, reason: 'ride_gone' };
    if (status === 'canceled' || status === 'cancelled') return { ok: false, reason: 'cancelled' };
    if (status !== 'searching') return { ok: false, reason: 'assigned_elsewhere' };
    if (await this.ports.isRideAssigned(run.rideId)) {
      return { ok: false, reason: 'assigned_elsewhere' };
    }
    if (this.ports.isDispatchPaused && (await this.ports.isDispatchPaused(run.rideId))) {
      return { ok: false, reason: 'operations_control' };
    }

    const now = this.ports.now();
    if (run.remainingLifetimeMs(now) <= 0) {
      run.evidence.markLifetimeExpired();
      return { ok: false, reason: 'lifetime_exceeded' };
    }
    // Don't open a round we cannot finish a single tier of.
    if (round > 1 && run.remainingLifetimeMs(now) < this.config.minRoundHeadroomMs) {
      run.evidence.markLifetimeExpired();
      this.ports.log('round_skipped', {
        rideId: run.rideId,
        round,
        reason: 'insufficient_lifetime_headroom',
        remainingMs: run.remainingLifetimeMs(now),
        minRoundHeadroomMs: this.config.minRoundHeadroomMs,
      });
      return { ok: false, reason: 'lifetime_exceeded' };
    }

    return { ok: true };
  }

  /** One round: walk its radius tiers. Returns a stop reason, or null to continue. */
  private async runRound(
    run: DispatchRun,
    round: number,
    tiers: number[],
    pickup: { lat: number; lng: number },
  ): Promise<DispatchStopReason | null> {
    for (const radiusKm of tiers) {
      if (run.isAborted) return run.stopReason ?? 'aborted';

      const gate = await this.canStartRound(run, round === 1 ? 1 : round);
      if (!gate.ok) return gate.reason;

      const now = this.ports.now();
      if (run.remainingLifetimeMs(now) <= 0) {
        run.evidence.markLifetimeExpired();
        return 'lifetime_exceeded';
      }

      this.ports.emitToRide(run.rideId, 'ride:searching', {
        rideId: run.rideId,
        radius: radiusKm,
        dispatchRound: round,
      });

      // Mirror the live search area for the passenger's read-only nearby-Keke
      // feed. Purely informational — nothing in dispatch reads it back.
      try {
        await DispatchService.publishSearchContext({
          rideId: run.rideId,
          dispatchRound: round,
          radiusKm,
          lat: pickup.lat,
          lng: pickup.lng,
          updatedAt: this.ports.now(),
        });
      } catch {
        /* the map feed falls back to the ride's own pickup + first tier */
      }

      const offered = await this.dispatchTier(run, round, radiusKm, pickup);

      if (run.isAborted) return run.stopReason ?? 'aborted';

      if (offered === 0) {
        await this.ports.sleep(this.config.emptyTierPauseMs);
        continue;
      }

      // Wait out the offer window (or until every open offer is answered).
      const wait = Math.min(this.config.offerDurationMs, run.remainingLifetimeMs(this.ports.now()));
      await this.ports.sleep(wait);

      if (run.isAborted) return run.stopReason ?? 'aborted';

      // Anything still open when the window closes is an expired offer.
      for (const driverId of run.openOfferIds) {
        run.evidence.offerExpired(driverId);
        run.closeOffer(driverId);
        this.ports.log('offer_expiry', { rideId: run.rideId, driverId, round, radiusKm });
        // Free the driver for other rides straight away rather than waiting for
        // the reservation TTL to lapse.
        try {
          await DispatchService.releaseDriver(driverId, run.rideId);
        } catch {
          /* the TTL is the backstop */
        }
      }
    }
    return null;
  }

  /**
   * One radius tier: discover, filter, reserve, offer. Returns how many offers
   * were genuinely delivered.
   */
  private async dispatchTier(
    run: DispatchRun,
    round: number,
    radiusKm: number,
    pickup: { lat: number; lng: number },
  ): Promise<number> {
    const { rideId, evidence } = run;

    const discovered = await this.ports.findNearby(
      pickup.lat,
      pickup.lng,
      radiusKm,
      this.config.candidateLimit,
    );

    for (const c of discovered) evidence.discovered(c.driverId, c.distanceKm);
    this.ports.log('candidates_discovered', {
      rideId,
      round,
      radiusKm,
      count: discovered.length,
      candidates: discovered.map((c) => ({ driverId: c.driverId, distanceKm: c.distanceKm })),
    });

    if (discovered.length === 0) return 0;

    // Drop anyone this round must not contact.
    const contactable = discovered.filter((c) => this.mayContact(run, c.driverId, round));
    for (const c of discovered) {
      if (!contactable.some((k) => k.driverId === c.driverId)) {
        const reason = evidence.hasRejected(c.driverId) ? 'explicit_rejector' : 'reoffer_cooldown';
        evidence.ineligible(c.driverId, reason);
        this.ports.log('eligibility_reject', { rideId, round, driverId: c.driverId, reason });
      }
    }
    if (contactable.length === 0) return 0;

    const { eligible, rejected } = await this.ports.filterEligible(contactable.map((c) => c.driverId));
    for (const r of rejected) {
      evidence.ineligible(r.driverId, r.reason);
      this.ports.log('eligibility_reject', { rideId, round, driverId: r.driverId, reason: r.reason });
    }
    for (const driverId of eligible) evidence.eligible(driverId);
    if (eligible.length === 0) return 0;

    // ATOMIC RESERVATION, unchanged: SET NX before any offer goes out, so two
    // concurrent rides can never ring or assign the same driver.
    const free = await DispatchService.filterUnreserved(eligible, rideId);
    for (const driverId of eligible) {
      if (!free.includes(driverId)) {
        const owner = await DispatchService.getReservationOwner(driverId);
        evidence.reservationSkipped(driverId, owner);
        this.ports.log('reserve', { rideId, round, driverId, result: 'skipped_reserved', reservedBy: owner });
      }
    }

    const reserved: string[] = [];
    for (const driverId of free) {
      // Freshness is re-checked here, not at discovery: a heartbeat can lapse in
      // the seconds spent filtering, and offering into that gap is what used to
      // be miscounted as a driver having been "rung".
      if (!(await this.ports.isDriverAvailable(driverId))) {
        evidence.staleBeforeOffer(driverId);
        this.ports.log('candidate_stale', { rideId, round, driverId, reason: 'stale_heartbeat' });
        continue;
      }
      const won = await DispatchService.reserveDriver(driverId, rideId);
      if (won) {
        reserved.push(driverId);
        evidence.reserved(driverId);
        this.ports.log('reserve', {
          rideId,
          round,
          driverId,
          result: 'acquired',
          ttlSec: DispatchService.RESERVATION_TTL_SECONDS,
        });
      } else {
        const owner = await DispatchService.getReservationOwner(driverId);
        evidence.reservationSkipped(driverId, owner);
        this.ports.log('reserve', { rideId, round, driverId, result: 'skipped_reserved', reservedBy: owner });
      }
    }

    if (reserved.length === 0) return 0;

    let sent = 0;
    for (const driverId of reserved) {
      if (run.isAborted) break;

      evidence.offerQueued(driverId);
      this.ports.log('offer_queued', { rideId, round, driverId, radiusKm });

      let delivery: OfferDelivery;
      try {
        delivery = await this.ports.sendOffer(driverId, round);
      } catch (err: any) {
        delivery = {
          delivered: false,
          socketDelivered: false,
          pushSuccessCount: 0,
          reason: `send_threw:${err?.message ?? 'unknown'}`,
        };
      }

      if (delivery.delivered) {
        sent += 1;
        evidence.offerSent(driverId, this.ports.now());
        run.noteOfferOpen(driverId);
        this.ports.log('offer_sent', {
          rideId,
          round,
          driverId,
          radiusKm,
          socketDelivered: delivery.socketDelivered,
          pushSuccessCount: delivery.pushSuccessCount,
        });
      } else {
        evidence.deliveryFailed(driverId, delivery.reason ?? 'no_transport_available');
        this.ports.log('offer_delivery_failed', {
          rideId,
          round,
          driverId,
          radiusKm,
          reason: delivery.reason ?? 'no_transport_available',
        });
        // Nobody can answer an offer that never arrived — don't hold the driver.
        try {
          await DispatchService.releaseDriver(driverId, rideId);
        } catch {
          /* TTL backstop */
        }
      }
    }

    return sent;
  }

  /**
   * Whether this round may contact a driver at all:
   * explicit rejectors are excluded, and a driver already offered this ride is
   * only re-offered once the configured cooldown has elapsed.
   */
  private mayContact(run: DispatchRun, driverId: string, round: number): boolean {
    const { evidence } = run;

    if (evidence.hasRejected(driverId) && !this.config.reofferRejectors) return false;

    const lastOffered = evidence.lastOfferedAt(driverId);
    if (lastOffered == null) return true;

    // Never twice within one round (the tiers of a round must not re-ring the
    // same driver); across rounds only once the cooldown has elapsed.
    if (evidence.lastOfferedRound(driverId) === round) return false;

    return this.ports.now() - lastOffered >= this.config.reofferCooldownMs;
  }

  /** Trim the internal ledger down to the fields the passenger app receives. */
  private publicSummary(summary: DispatchSummary): Record<string, unknown> {
    return {
      eligibleDriverCount: summary.eligibleDriverCount,
      reservedDriverCount: summary.reservedDriverCount,
      offersSentCount: summary.offersSentCount,
      explicitRejectCount: summary.explicitRejectCount,
      expiredOfferCount: summary.expiredOfferCount,
      deliveryFailureCount: summary.deliveryFailureCount,
      acknowledgedCount: summary.acknowledgedCount,
    };
  }

  private finish(run: DispatchRun, stopReason: DispatchStopReason): DispatchResult {
    run.evidence.endRound(this.ports.now());

    // The ride is no longer searching: drop the mirrored search area so no
    // marker feed can keep serving supply for a finished search.
    void DispatchService.clearSearchContext(run.rideId).catch(() => {
      /* TTL is the backstop */
    });

    if (stopReason === 'lifetime_exceeded') run.evidence.markLifetimeExpired();

    const succeeded = stopReason === 'accepted' || stopReason === 'assigned_elsewhere';
    const summary = run.evidence.summary(!succeeded);
    const outcome = succeeded ? null : run.evidence.classify();

    this.ports.log('dispatch_finished', {
      rideId: run.rideId,
      stopReason,
      elapsedMs: run.elapsedMs(this.ports.now()),
      finalOutcomeCode: outcome?.code ?? null,
      dispatchResult: outcome?.dispatchResult ?? null,
      summary,
    });

    return { stopReason, summary, outcome };
  }

  /** The passenger-visible slice of a summary, for the caller's failure event. */
  static publicPayload(summary: DispatchSummary): Record<string, unknown> {
    return {
      dispatchRound: summary.dispatchRound,
      roundsRun: summary.roundsRun,
      eligibleDriverCount: summary.eligibleDriverCount,
      reservedDriverCount: summary.reservedDriverCount,
      offersSentCount: summary.offersSentCount,
      explicitRejectCount: summary.explicitRejectCount,
      expiredOfferCount: summary.expiredOfferCount,
      deliveryFailureCount: summary.deliveryFailureCount,
      acknowledgedCount: summary.acknowledgedCount,
      finalOutcomeCode: summary.finalOutcomeCode,
    };
  }
}
