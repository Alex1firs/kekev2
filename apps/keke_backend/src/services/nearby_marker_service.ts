/**
 * Privacy transform for passenger-facing nearby-Keke markers.
 *
 * A marker answers exactly one question — "is there a real, dispatchable Keke
 * roughly there?" — and nothing else. It carries no driver id, name, phone,
 * plate, rating, photo, heading or history, and its position is deliberately
 * approximated so the passenger cannot follow an individual driver around before
 * that driver has accepted anything.
 *
 * Nothing here selects drivers. Selection is [[DriverEligibilityService]] plus
 * the dispatch reservation checks; this only decides what may be shown.
 */
import crypto from 'crypto';

/** What the passenger app receives per marker. Add nothing identifying here. */
export interface NearbyKekeMarker {
  /**
   * Opaque, stable-within-this-ride handle. Lets the client animate the same
   * marker between refreshes (no flicker) while being unlinkable to a driver or
   * across rides. NOT a driver id — never send one to a passenger.
   */
  key: string;
  /** Approximated position — see [[APPROX_RADIUS_M]]. */
  lat: number;
  lng: number;
  /** Epoch ms after which the client must drop this marker. */
  expiresAt: number;
}

export interface MarkerFeed {
  markers: NearbyKekeMarker[];
  /** Truthful count of eligible drivers found, before the display cap. */
  eligibleCount: number;
  /** How coarse the positions are, so the UI can be honest about precision. */
  approximateRadiusMeters: number;
  /** When the client should poll again. */
  refreshAfterMs: number;
}

const SALT = process.env.MARKER_KEY_SALT || process.env.JWT_SECRET || 'keke-marker-salt';

export class NearbyMarkerService {
  /**
   * Markers self-expire slightly after the next scheduled refresh, so a client
   * that loses connectivity stops showing supply it can no longer verify rather
   * than leaving a reassuring but stale picture on screen.
   */
  static readonly MARKER_TTL_MS = 20_000;

  /** Controlled refresh cadence. Deliberately NOT per-heartbeat streaming. */
  static readonly REFRESH_INTERVAL_MS = 8_000;

  /**
   * Positions are snapped to a grid this size and then given a fixed per-marker
   * offset, so a marker sits somewhere within roughly this radius of the driver.
   * ~120 m is enough to stop doorstep-level identification while still reading as
   * "there is a Keke on the next street".
   */
  static readonly APPROX_RADIUS_M = 120;

  /**
   * Upper bound on markers shown. Caps information disclosure and keeps the map
   * cheap on low-end devices; the honest total is reported separately as
   * [[MarkerFeed.eligibleCount]].
   */
  static readonly MAX_MARKERS = 6;

  private static readonly M_PER_DEG_LAT = 111_320;

  /** Stable pseudonymous key for a driver *within one ride*. */
  static markerKey(rideId: string, driverId: string): string {
    return crypto
      .createHmac('sha256', SALT)
      .update(`${rideId}:${driverId}`)
      .digest('hex')
      .slice(0, 12);
  }

  /** Deterministic unit value in [0,1) derived from a key and a channel name. */
  private static hashUnit(key: string, channel: string): number {
    const digest = crypto.createHash('sha256').update(`${key}:${channel}`).digest();
    return digest.readUInt32BE(0) / 0x1_0000_0000;
  }

  /**
   * Approximate a coordinate: snap to a grid, then apply a per-marker offset
   * derived from the marker key.
   *
   * The offset is DETERMINISTIC on purpose. Random jitter per refresh would make
   * every marker twitch on the map every few seconds — both ugly and a privacy
   * illusion, since averaging repeated samples recovers the true position.
   */
  static approximate(lat: number, lng: number, key: string): { lat: number; lng: number } {
    const gridDegLat = this.APPROX_RADIUS_M / this.M_PER_DEG_LAT;
    const cosLat = Math.max(0.1, Math.cos((lat * Math.PI) / 180));
    const gridDegLng = this.APPROX_RADIUS_M / (this.M_PER_DEG_LAT * cosLat);

    const snappedLat = Math.round(lat / gridDegLat) * gridDegLat;
    const snappedLng = Math.round(lng / gridDegLng) * gridDegLng;

    // Offset within the cell, on a circle so the result is not biased to corners.
    const angle = this.hashUnit(key, 'angle') * 2 * Math.PI;
    const radius = Math.sqrt(this.hashUnit(key, 'radius')); // uniform over the disc
    const offsetLat = Math.sin(angle) * radius * gridDegLat * 0.5;
    const offsetLng = Math.cos(angle) * radius * gridDegLng * 0.5;

    return {
      lat: Number((snappedLat + offsetLat).toFixed(6)),
      lng: Number((snappedLng + offsetLng).toFixed(6)),
    };
  }

  /**
   * Build the passenger-visible feed from an ALREADY-FILTERED, nearest-first list
   * of dispatch-eligible drivers.
   *
   * Callers must have applied every eligibility and reservation check first —
   * this method trusts its input and only anonymises it. It never invents,
   * pads or simulates a marker: an empty input yields an empty feed.
   */
  static buildFeed(
    drivers: ReadonlyArray<{ driverId: string; lat: number; lng: number }>,
    opts: { scopeId: string; now: number },
  ): MarkerFeed {
    const eligibleCount = drivers.length;

    // Nearest-first input, so capping keeps the drivers actually near the
    // passenger rather than an arbitrary sample.
    const shown = drivers.slice(0, this.MAX_MARKERS).map((d) => {
      const key = this.markerKey(opts.scopeId, d.driverId);
      const approx = this.approximate(d.lat, d.lng, key);
      return { key, lat: approx.lat, lng: approx.lng, expiresAt: opts.now + this.MARKER_TTL_MS };
    });

    // Emit in a deterministic key order rather than proximity order: array
    // position must not leak dispatch's candidate ranking.
    shown.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

    return {
      markers: shown,
      eligibleCount,
      approximateRadiusMeters: this.APPROX_RADIUS_M,
      refreshAfterMs: this.REFRESH_INTERVAL_MS,
    };
  }
}
