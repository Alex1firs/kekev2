/**
 * Privacy transform and search-context mirror for passenger-facing nearby-Keke
 * markers.
 *
 * The eligibility/reservation filtering that feeds this is covered by
 * test/unit/redispatch.test.ts (same DriverEligibilityService) and by the
 * passenger-side tests; here the focus is what a marker may and may not reveal.
 */
import { NearbyMarkerService } from '../../src/services/nearby_marker_service';
import { DispatchService } from '../../src/services/dispatch_service';
import { newDriver, newRide, setHeartbeatFresh, redis } from '../helpers/dispatch';

const NOW = 1_700_000_000_000;
const AWKA = { lat: 6.2097, lng: 7.0562 };

const driverAt = (driverId: string, lat: number, lng: number) => ({ driverId, lat, lng });

describe('marker privacy', () => {
  it('exposes only an opaque key, a position and an expiry', () => {
    const rideId = newRide();
    const feed = NearbyMarkerService.buildFeed([driverAt(newDriver(), AWKA.lat, AWKA.lng)], {
      scopeId: rideId,
      now: NOW,
    });

    expect(feed.markers).toHaveLength(1);
    expect(Object.keys(feed.markers[0]).sort()).toEqual(['expiresAt', 'key', 'lat', 'lng']);
  });

  it('never leaks a driver id, even inside the marker key', () => {
    const rideId = newRide();
    const driverId = newDriver();
    const feed = NearbyMarkerService.buildFeed([driverAt(driverId, AWKA.lat, AWKA.lng)], {
      scopeId: rideId,
      now: NOW,
    });

    const serialised = JSON.stringify(feed);
    expect(serialised).not.toContain(driverId);
    expect(feed.markers[0].key).not.toContain(driverId);
  });

  it('gives the same driver a stable key within one ride, so markers do not flicker', () => {
    const rideId = newRide();
    const driverId = newDriver();
    const first = NearbyMarkerService.markerKey(rideId, driverId);
    const second = NearbyMarkerService.markerKey(rideId, driverId);
    expect(first).toBe(second);
  });

  it('gives the same driver DIFFERENT keys across rides, so they are not trackable', () => {
    const driverId = newDriver();
    const keyA = NearbyMarkerService.markerKey(newRide(), driverId);
    const keyB = NearbyMarkerService.markerKey(newRide(), driverId);
    expect(keyA).not.toBe(keyB);
  });

  it('approximates the position rather than reporting it exactly', () => {
    const key = NearbyMarkerService.markerKey(newRide(), newDriver());
    const approx = NearbyMarkerService.approximate(AWKA.lat, AWKA.lng, key);

    expect(approx.lat).not.toBe(AWKA.lat);
    expect(approx.lng).not.toBe(AWKA.lng);

    // …but stays within a believable neighbourhood of the truth.
    const metresPerDegLat = 111_320;
    const dLat = Math.abs(approx.lat - AWKA.lat) * metresPerDegLat;
    const dLng =
      Math.abs(approx.lng - AWKA.lng) * metresPerDegLat * Math.cos((AWKA.lat * Math.PI) / 180);
    const displacement = Math.hypot(dLat, dLng);
    expect(displacement).toBeGreaterThan(0);
    expect(displacement).toBeLessThan(NearbyMarkerService.APPROX_RADIUS_M * 2.5);
  });

  it('approximates deterministically so markers do not twitch between refreshes', () => {
    // Random per-refresh jitter would both look broken and be defeated by
    // averaging repeated samples.
    const key = NearbyMarkerService.markerKey(newRide(), newDriver());
    const a = NearbyMarkerService.approximate(AWKA.lat, AWKA.lng, key);
    const b = NearbyMarkerService.approximate(AWKA.lat, AWKA.lng, key);
    expect(a).toEqual(b);
  });

  it('moves a marker when the driver genuinely moves a street over', () => {
    const key = NearbyMarkerService.markerKey(newRide(), newDriver());
    const before = NearbyMarkerService.approximate(AWKA.lat, AWKA.lng, key);
    const after = NearbyMarkerService.approximate(AWKA.lat + 0.01, AWKA.lng, key);
    expect(after.lat).not.toBe(before.lat);
  });

  it('caps the markers shown but still reports the honest eligible count', () => {
    const rideId = newRide();
    const many = Array.from({ length: NearbyMarkerService.MAX_MARKERS + 7 }, (_, i) =>
      driverAt(newDriver(), AWKA.lat + i * 0.001, AWKA.lng),
    );

    const feed = NearbyMarkerService.buildFeed(many, { scopeId: rideId, now: NOW });

    expect(feed.markers).toHaveLength(NearbyMarkerService.MAX_MARKERS);
    expect(feed.eligibleCount).toBe(many.length);
  });

  it('does not order markers by proximity, so dispatch ranking is not leaked', () => {
    const rideId = newRide();
    // Input is strictly nearest-first.
    const ordered = Array.from({ length: NearbyMarkerService.MAX_MARKERS }, (_, i) =>
      driverAt(`driver_rank_${i}`, AWKA.lat + i * 0.002, AWKA.lng),
    );

    const feed = NearbyMarkerService.buildFeed(ordered, { scopeId: rideId, now: NOW });
    const emittedKeys = feed.markers.map((m) => m.key);
    const proximityKeys = ordered.map((d) => NearbyMarkerService.markerKey(rideId, d.driverId));

    expect(emittedKeys).toHaveLength(proximityKeys.length);
    expect([...emittedKeys].sort()).toEqual([...proximityKeys].sort());
    // Deterministic key order, not input order.
    expect(emittedKeys).toEqual([...emittedKeys].sort());
  });

  it('stamps an expiry so a disconnected client stops showing unverified supply', () => {
    const feed = NearbyMarkerService.buildFeed([driverAt(newDriver(), AWKA.lat, AWKA.lng)], {
      scopeId: newRide(),
      now: NOW,
    });
    expect(feed.markers[0].expiresAt).toBe(NOW + NearbyMarkerService.MARKER_TTL_MS);
    // Expiry must outlast the refresh interval, or markers would blink each cycle.
    expect(NearbyMarkerService.MARKER_TTL_MS).toBeGreaterThan(NearbyMarkerService.REFRESH_INTERVAL_MS);
  });

  it('refreshes on a controlled interval, not per heartbeat', () => {
    // A driver heartbeat is every ~12s; the point is that markers are a periodic
    // snapshot, never a live per-heartbeat stream before assignment.
    expect(NearbyMarkerService.REFRESH_INTERVAL_MS).toBeGreaterThanOrEqual(5_000);
  });

  it('never invents supply for an empty input', () => {
    const feed = NearbyMarkerService.buildFeed([], { scopeId: newRide(), now: NOW });
    expect(feed.markers).toEqual([]);
    expect(feed.eligibleCount).toBe(0);
  });
});

describe('search-context mirror', () => {
  it('round-trips the live search area for the marker feed to read', async () => {
    const rideId = newRide();
    await DispatchService.publishSearchContext({
      rideId,
      dispatchRound: 2,
      radiusKm: 6.5,
      lat: AWKA.lat,
      lng: AWKA.lng,
      updatedAt: NOW,
    });

    const ctx = await DispatchService.getSearchContext(rideId);
    expect(ctx).not.toBeNull();
    expect(ctx!.dispatchRound).toBe(2);
    expect(ctx!.radiusKm).toBe(6.5);
    expect(ctx!.lat).toBeCloseTo(AWKA.lat);
  });

  it('reports nothing for a ride that was never dispatched', async () => {
    expect(await DispatchService.getSearchContext(newRide())).toBeNull();
  });

  it('is cleared so a finished search cannot keep serving a marker feed', async () => {
    const rideId = newRide();
    await DispatchService.publishSearchContext({
      rideId,
      dispatchRound: 1,
      radiusKm: 2,
      lat: AWKA.lat,
      lng: AWKA.lng,
      updatedAt: NOW,
    });
    await DispatchService.clearSearchContext(rideId);
    expect(await DispatchService.getSearchContext(rideId)).toBeNull();
  });

  it('survives a corrupt value without breaking the feed', async () => {
    const rideId = newRide();
    await redis.set(DispatchService.searchContextKey(rideId), 'not json');
    expect(await DispatchService.getSearchContext(rideId)).toBeNull();
  });

  it('the orchestrator publishes the tier it is actually working', async () => {
    // Integration point: the orchestrator writes this at each tier start, so the
    // map feed follows round two's wider radius without its own radius logic.
    const { OrchestratorHarness } = await import('../helpers/orchestrator');
    const rideId = newRide();
    const h = new OrchestratorHarness(rideId, {
      radiusTiersKm: [2],
      roundTwoRadiusTiersKm: [6],
      offerDurationMs: 1_000,
      emptyTierPauseMs: 100,
      roundGapMs: 50,
      maxSearchLifetimeMs: 300_000,
      minRoundHeadroomMs: 100,
    });
    const driverId = newDriver();
    h.drivers = [{ driverId, withinKm: 1 }];
    await setHeartbeatFresh(driverId);

    const radii: number[] = [];
    const originalPublish = DispatchService.publishSearchContext;
    (DispatchService as any).publishSearchContext = async (ctx: any) => {
      radii.push(ctx.radiusKm);
      return originalPublish.call(DispatchService, ctx);
    };
    try {
      await h.orchestrator.run(h.run, AWKA);
    } finally {
      (DispatchService as any).publishSearchContext = originalPublish;
    }

    expect(radii).toContain(2); // round one
    expect(radii).toContain(6); // round two, wider
  });
});
