/**
 * Dispatch evidence ledger.
 *
 * The passenger-facing outcome used to be inferred from `driversRung > 0`, where
 * "rung" meant nothing more than "this driver's id was in a Redis candidate
 * set". That over-claims: a driver can be discovered, pass eligibility, even be
 * reserved, and still never receive anything — no live socket, no device token,
 * a failed FCM multicast, or a heartbeat that went stale in the moments before
 * the offer went out.
 *
 * This ledger records what actually happened to every candidate, so the final
 * outcome rests on real delivery evidence instead of set membership.
 */

/** The lifecycle a single candidate driver can move through, in order. */
export enum CandidateState {
  /** 1. Returned by the geo query for this round. */
  DISCOVERED = 'discovered',
  /** 2. Passed every eligibility check (status, debt, busy, exclusions). */
  ELIGIBLE = 'eligible',
  /** 3. Atomically reserved by this ride (SET NX won). */
  RESERVED = 'reserved',
  /** 4. Offer handed to the transport layer. */
  OFFER_QUEUED = 'offer_queued',
  /** 5. Transport confirmed it reached the device (live socket or accepted push). */
  OFFER_SENT = 'offer_sent',
  /** 6. The driver app acknowledged the offer. Only newer driver builds do this. */
  ACKNOWLEDGED = 'acknowledged',
  /** 7. The driver said no. */
  REJECTED = 'rejected',
  /** 8. The offer window closed with no answer. */
  OFFER_EXPIRED = 'offer_expired',
  /** 9. Neither socket nor push could deliver the offer. */
  DELIVERY_FAILED = 'delivery_failed',
  /** 10. Heartbeat/location went stale between discovery and the offer. */
  STALE_BEFORE_OFFER = 'stale_before_offer',
}

/** Outcome codes shared with the passenger app (see booking_notice.dart). */
export type DispatchOutcomeCode = 'NO_ELIGIBLE_DRIVER' | 'NO_DRIVER_ACCEPTED' | 'REQUEST_EXPIRED';

export interface CandidateRecord {
  driverId: string;
  round: number;
  distanceKm: number | null;
  states: CandidateState[];
  /** Why eligibility or reservation rejected this candidate, when it did. */
  reason?: string;
  /** Epoch ms of the last offer sent to this driver, for cooldown decisions. */
  lastOfferedAt?: number;
  /**
   * Round in which the last offer went out. Tracked separately from [[round]],
   * which follows the LATEST round that rediscovered the driver — conflating the
   * two makes a legitimate cross-round re-offer look like a same-round repeat.
   */
  lastOfferedRound?: number;
}

export interface RoundSummary {
  round: number;
  radiusTiersKm: number[];
  discoveredCount: number;
  eligibleDriverCount: number;
  reservedDriverCount: number;
  offersQueuedCount: number;
  offersSentCount: number;
  acknowledgedCount: number;
  explicitRejectCount: number;
  expiredOfferCount: number;
  deliveryFailureCount: number;
  staleBeforeOfferCount: number;
  startedAt: number;
  endedAt: number | null;
}

export interface DispatchSummary {
  rideId: string;
  dispatchRound: number;
  roundsRun: number;
  /** Totals across every round. */
  eligibleDriverCount: number;
  reservedDriverCount: number;
  offersQueuedCount: number;
  offersSentCount: number;
  acknowledgedCount: number;
  explicitRejectCount: number;
  expiredOfferCount: number;
  deliveryFailureCount: number;
  staleBeforeOfferCount: number;
  finalOutcomeCode: DispatchOutcomeCode | null;
  dispatchResult: string | null;
  rounds: RoundSummary[];
  /**
   * Retained from the previous `ride:failed` payload shape so anything already
   * consuming it keeps working. Its MEANING is corrected: it now counts
   * genuinely-delivered offers, not candidate-set membership, so a consumer that
   * infers "drivers were busy" from `driversRung > 0` reaches the same
   * conclusion as [[finalOutcomeCode]] instead of contradicting it.
   */
  driversRung: number;
}

const emptyRound = (round: number, radiusTiersKm: number[], startedAt: number): RoundSummary => ({
  round,
  radiusTiersKm,
  discoveredCount: 0,
  eligibleDriverCount: 0,
  reservedDriverCount: 0,
  offersQueuedCount: 0,
  offersSentCount: 0,
  acknowledgedCount: 0,
  explicitRejectCount: 0,
  expiredOfferCount: 0,
  deliveryFailureCount: 0,
  staleBeforeOfferCount: 0,
  startedAt,
  endedAt: null,
});

export class DispatchEvidence {
  readonly rideId: string;
  private readonly candidates = new Map<string, CandidateRecord>();
  private readonly rounds: RoundSummary[] = [];
  private currentRound = 0;
  private accepted: { driverId: string; round: number } | null = null;
  private expiredByLifetime = false;

  constructor(rideId: string) {
    this.rideId = rideId;
  }

  get round(): number {
    return this.currentRound;
  }

  beginRound(round: number, radiusTiersKm: number[], now: number): void {
    this.currentRound = round;
    this.rounds.push(emptyRound(round, radiusTiersKm, now));
  }

  endRound(now: number): void {
    const current = this.rounds[this.rounds.length - 1];
    if (current && current.endedAt == null) current.endedAt = now;
  }

  private roundSummary(): RoundSummary | undefined {
    return this.rounds[this.rounds.length - 1];
  }

  /** Candidate records for the given round (or all rounds when omitted). */
  candidatesFor(round?: number): CandidateRecord[] {
    const all = [...this.candidates.values()];
    return round == null ? all : all.filter((c) => c.round === round);
  }

  record(driverId: string): CandidateRecord {
    let existing = this.candidates.get(driverId);
    if (!existing) {
      existing = { driverId, round: this.currentRound, distanceKm: null, states: [] };
      this.candidates.set(driverId, existing);
    }
    return existing;
  }

  has(driverId: string): boolean {
    return this.candidates.has(driverId);
  }

  /** Whether this driver explicitly rejected the ride in ANY round. */
  hasRejected(driverId: string): boolean {
    return this.candidates.get(driverId)?.states.includes(CandidateState.REJECTED) ?? false;
  }

  /** Whether this driver was genuinely sent an offer in ANY round. */
  wasOffered(driverId: string): boolean {
    return this.candidates.get(driverId)?.states.includes(CandidateState.OFFER_SENT) ?? false;
  }

  lastOfferedAt(driverId: string): number | undefined {
    return this.candidates.get(driverId)?.lastOfferedAt;
  }

  private mark(driverId: string, state: CandidateState, patch?: Partial<CandidateRecord>): CandidateRecord {
    const rec = this.record(driverId);
    if (!rec.states.includes(state)) rec.states.push(state);
    if (patch) Object.assign(rec, patch);
    return rec;
  }

  // ── The ten candidate outcomes ──────────────────────────────────────────

  discovered(driverId: string, distanceKm: number | null): void {
    const rec = this.mark(driverId, CandidateState.DISCOVERED, { distanceKm });
    // A driver rediscovered in a later round belongs to that later round.
    rec.round = this.currentRound;
    const summary = this.roundSummary();
    if (summary) summary.discoveredCount += 1;
  }

  eligible(driverId: string): void {
    this.mark(driverId, CandidateState.ELIGIBLE);
    const summary = this.roundSummary();
    if (summary) summary.eligibleDriverCount += 1;
  }

  ineligible(driverId: string, reason: string): void {
    this.record(driverId).reason = reason;
  }

  reserved(driverId: string): void {
    this.mark(driverId, CandidateState.RESERVED);
    const summary = this.roundSummary();
    if (summary) summary.reservedDriverCount += 1;
  }

  reservationSkipped(driverId: string, reservedBy: string | null): void {
    this.record(driverId).reason = reservedBy ? `reserved_by:${reservedBy}` : 'reservation_lost';
  }

  offerQueued(driverId: string): void {
    this.mark(driverId, CandidateState.OFFER_QUEUED);
    const summary = this.roundSummary();
    if (summary) summary.offersQueuedCount += 1;
  }

  offerSent(driverId: string, now: number): void {
    this.mark(driverId, CandidateState.OFFER_SENT, {
      lastOfferedAt: now,
      lastOfferedRound: this.currentRound,
    });
    const summary = this.roundSummary();
    if (summary) summary.offersSentCount += 1;
  }

  /** Which round last sent this driver an offer (undefined if never offered). */
  lastOfferedRound(driverId: string): number | undefined {
    return this.candidates.get(driverId)?.lastOfferedRound;
  }

  deliveryFailed(driverId: string, reason: string): void {
    this.mark(driverId, CandidateState.DELIVERY_FAILED, { reason });
    const summary = this.roundSummary();
    if (summary) summary.deliveryFailureCount += 1;
  }

  acknowledged(driverId: string): void {
    const rec = this.candidates.get(driverId);
    // Only count an ack for a driver we actually offered this ride to.
    if (!rec || rec.states.includes(CandidateState.ACKNOWLEDGED)) return;
    this.mark(driverId, CandidateState.ACKNOWLEDGED);
    const summary = this.roundSummary();
    if (summary) summary.acknowledgedCount += 1;
  }

  rejected(driverId: string): void {
    const rec = this.candidates.get(driverId);
    if (rec?.states.includes(CandidateState.REJECTED)) return;
    this.mark(driverId, CandidateState.REJECTED);
    const summary = this.roundSummary();
    if (summary) summary.explicitRejectCount += 1;
  }

  offerExpired(driverId: string): void {
    const rec = this.candidates.get(driverId);
    if (!rec) return;
    // Expiry only applies to an offer that was really sent and never answered.
    if (!rec.states.includes(CandidateState.OFFER_SENT)) return;
    if (rec.states.includes(CandidateState.REJECTED)) return;
    if (rec.states.includes(CandidateState.OFFER_EXPIRED)) return;
    this.mark(driverId, CandidateState.OFFER_EXPIRED);
    const summary = this.roundSummary();
    if (summary) summary.expiredOfferCount += 1;
  }

  staleBeforeOffer(driverId: string, reason = 'stale_heartbeat'): void {
    this.mark(driverId, CandidateState.STALE_BEFORE_OFFER, { reason });
    const summary = this.roundSummary();
    if (summary) summary.staleBeforeOfferCount += 1;
  }

  acceptedBy(driverId: string): void {
    this.accepted = { driverId, round: this.currentRound };
  }

  markLifetimeExpired(): void {
    this.expiredByLifetime = true;
  }

  get acceptance(): { driverId: string; round: number } | null {
    return this.accepted;
  }

  private total(key: keyof RoundSummary): number {
    return this.rounds.reduce((sum, r) => sum + (r[key] as number), 0);
  }

  /**
   * Final classification, from delivery evidence only.
   *
   * - REQUEST_EXPIRED — the ride blew its overall search-lifetime budget.
   * - NO_DRIVER_ACCEPTED — at least one genuinely eligible driver was
   *   successfully offered the ride and nobody accepted.
   * - NO_ELIGIBLE_DRIVER — nobody passed eligibility and reservation, or nobody
   *   we reserved could actually be reached. In both cases no driver ever saw
   *   this request, so telling the passenger drivers were "busy" would be false.
   */
  classify(): { code: DispatchOutcomeCode; dispatchResult: string } {
    if (this.expiredByLifetime) {
      return { code: 'REQUEST_EXPIRED', dispatchResult: 'search_lifetime_exceeded' };
    }
    const offersSent = this.total('offersSentCount');
    if (offersSent > 0) {
      return { code: 'NO_DRIVER_ACCEPTED', dispatchResult: 'offers_delivered_none_accepted' };
    }
    const reserved = this.total('reservedDriverCount');
    const deliveryFailures = this.total('deliveryFailureCount');
    if (reserved > 0 && deliveryFailures > 0) {
      // Drivers existed and were reserved, but not one offer reached a device.
      return { code: 'NO_ELIGIBLE_DRIVER', dispatchResult: 'offers_all_failed_delivery' };
    }
    if (reserved > 0) {
      return { code: 'NO_ELIGIBLE_DRIVER', dispatchResult: 'reserved_but_no_offer_sent' };
    }
    if (this.total('eligibleDriverCount') > 0) {
      return { code: 'NO_ELIGIBLE_DRIVER', dispatchResult: 'eligible_but_none_reservable' };
    }
    return { code: 'NO_ELIGIBLE_DRIVER', dispatchResult: 'no_eligible_drivers' };
  }

  summary(includeOutcome = true): DispatchSummary {
    const outcome = includeOutcome && !this.accepted ? this.classify() : null;
    const offersSent = this.total('offersSentCount');
    return {
      rideId: this.rideId,
      dispatchRound: this.currentRound,
      roundsRun: this.rounds.length,
      eligibleDriverCount: this.total('eligibleDriverCount'),
      reservedDriverCount: this.total('reservedDriverCount'),
      offersQueuedCount: this.total('offersQueuedCount'),
      offersSentCount: offersSent,
      acknowledgedCount: this.total('acknowledgedCount'),
      explicitRejectCount: this.total('explicitRejectCount'),
      expiredOfferCount: this.total('expiredOfferCount'),
      deliveryFailureCount: this.total('deliveryFailureCount'),
      staleBeforeOfferCount: this.total('staleBeforeOfferCount'),
      finalOutcomeCode: outcome?.code ?? null,
      dispatchResult: outcome?.dispatchResult ?? null,
      rounds: this.rounds.map((r) => ({ ...r })),
      // Genuinely-delivered offers, NOT candidate-set size.
      driversRung: offersSent,
    };
  }
}
