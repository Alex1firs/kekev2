/**
 * Dispatch tuning — every round/radius/duration knob lives here.
 *
 * Nothing about dispatch timing or geometry should be hardcoded at a call site:
 * field tuning happens through these environment variables, and the tests drive
 * the orchestrator by overriding this object rather than by faking clocks in
 * several places.
 */

export interface DispatchConfig {
  /**
   * Automatic dispatch rounds per ride. HARD-CAPPED at [[MAX_SUPPORTED_ROUNDS]]:
   * the product decision for this release is at most two automatic rounds and no
   * indefinite searching, so a mis-set env var cannot widen it.
   */
  maxRounds: number;

  /** Round-one radius tiers in km, nearest first. */
  radiusTiersKm: number[];

  /**
   * Round-two radius tiers in km. Defaults to an expansion of the round-one
   * tiers (see [[defaultRoundTwoTiers]]) so round two genuinely reaches further
   * out rather than re-scanning the same ground.
   */
  roundTwoRadiusTiersKm: number[];

  /** How long one tier's offer stays open before moving on. */
  offerDurationMs: number;

  /** Pause after a tier that produced no offer at all, before the next tier. */
  emptyTierPauseMs: number;

  /** Gap between the end of round one and the start of round two. */
  roundGapMs: number;

  /**
   * A driver who was offered this ride and did not answer may be offered again
   * in a later round only after this long since their last offer. Stops the same
   * driver being re-rung back-to-back.
   */
  reofferCooldownMs: number;

  /**
   * Whether a driver who EXPLICITLY rejected may be re-offered in a later round
   * (subject to the cooldown). False for this release: an explicit "no" is
   * respected for the life of the ride.
   */
  reofferRejectors: boolean;

  /**
   * Total wall-clock budget for searching, across all rounds. Exceeding it ends
   * the search as REQUEST_EXPIRED. This is the ceiling that makes "no indefinite
   * searching" structural rather than a matter of loop arithmetic.
   */
  maxSearchLifetimeMs: number;

  /** Max candidates pulled from the geo index per tier query. */
  candidateLimit: number;

  /**
   * A round is only started if at least this much of the lifetime budget
   * remains — starting a round that cannot complete one tier just delays the
   * passenger's answer for nothing.
   */
  minRoundHeadroomMs: number;
}

/** Product ceiling for this release. Config cannot exceed it. */
export const MAX_SUPPORTED_ROUNDS = 2;

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    console.warn(`[dispatch-config] ${name}="${raw}" is not a valid number — using ${fallback}`);
    return fallback;
  }
  return parsed;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return fallback;
  return raw.trim().toLowerCase() === 'true';
}

function tiers(name: string, fallback: number[]): number[] {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return fallback;
  const parsed = raw
    .split(',')
    .map((s) => parseFloat(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (parsed.length === 0) {
    console.warn(`[dispatch-config] ${name}="${raw}" yielded no usable tiers — using ${fallback.join(',')}`);
    return fallback;
  }
  return parsed;
}

/**
 * Round two continues outward from where round one stopped: it starts at round
 * one's widest tier and adds one further step of the same size. Round one
 * "2,3.5,5" therefore becomes round two "5,6.5" — new ground, not a rescan.
 */
export function defaultRoundTwoTiers(roundOne: number[]): number[] {
  if (roundOne.length === 0) return [];
  const widest = roundOne[roundOne.length - 1];
  const step = roundOne.length > 1 ? widest - roundOne[roundOne.length - 2] : widest / 2;
  return [widest, Number((widest + Math.max(step, 0.5)).toFixed(2))];
}

export function loadDispatchConfig(): DispatchConfig {
  const radiusTiersKm = tiers('DISPATCH_RADIUS_TIERS_KM', [2, 3.5, 5]);
  const requestedRounds = Math.floor(num('DISPATCH_MAX_ROUNDS', 2));
  const maxRounds = Math.min(Math.max(requestedRounds, 1), MAX_SUPPORTED_ROUNDS);
  if (requestedRounds > MAX_SUPPORTED_ROUNDS) {
    console.warn(
      `[dispatch-config] DISPATCH_MAX_ROUNDS=${requestedRounds} exceeds the ` +
        `${MAX_SUPPORTED_ROUNDS}-round product ceiling for this release — clamped to ${maxRounds}.`,
    );
  }

  return {
    maxRounds,
    radiusTiersKm,
    roundTwoRadiusTiersKm: tiers('DISPATCH_ROUND2_RADIUS_TIERS_KM', defaultRoundTwoTiers(radiusTiersKm)),
    offerDurationMs: num('DISPATCH_OFFER_DURATION_MS', 15_000),
    emptyTierPauseMs: num('DISPATCH_EMPTY_TIER_PAUSE_MS', 3_000),
    roundGapMs: num('DISPATCH_ROUND_GAP_MS', 1_000),
    reofferCooldownMs: num('DISPATCH_REOFFER_COOLDOWN_MS', 45_000),
    reofferRejectors: bool('DISPATCH_REOFFER_REJECTORS', false),
    maxSearchLifetimeMs: num('DISPATCH_MAX_SEARCH_LIFETIME_MS', 110_000),
    candidateLimit: Math.floor(num('DISPATCH_CANDIDATE_LIMIT', 10)),
    minRoundHeadroomMs: num('DISPATCH_MIN_ROUND_HEADROOM_MS', 8_000),
  };
}

/** Radius tiers for a given 1-based round. */
export function tiersForRound(config: DispatchConfig, round: number): number[] {
  return round <= 1 ? config.radiusTiersKm : config.roundTwoRadiusTiersKm;
}
