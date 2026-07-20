/**
 * Unit + lifecycle tests for the atomic driver-reservation service.
 * Runs entirely against the in-memory Redis mock — no DB, no network.
 */
import {
  DispatchService,
  redis,
  newDriver,
  newPassenger,
  newRide,
  setHeartbeatFresh,
  setHeartbeatExpired,
  reservationOwner,
} from '../helpers/dispatch';

describe('reservation primitives', () => {
  it('reserveDriver is exclusive: a second ride cannot reserve a held driver', async () => {
    const d = newDriver();
    const rideA = newRide();
    const rideB = newRide();

    expect(await DispatchService.reserveDriver(d, rideA)).toBe(true);
    expect(await DispatchService.reserveDriver(d, rideB)).toBe(false); // already held
    expect(await DispatchService.getReservationOwner(d)).toBe(rideA);
  });

  it('sets an expiry (TTL) on the reservation as a self-healing backstop', async () => {
    const d = newDriver();
    await DispatchService.reserveDriver(d, newRide());
    const ttl = await redis.ttl(DispatchService.reservedKey(d));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(DispatchService.RESERVATION_TTL_SECONDS);
  });

  it('filterUnreserved keeps free drivers + own reservations, drops others (point 10)', async () => {
    const [d1, d2, d3] = [newDriver(), newDriver(), newDriver()];
    const mine = newRide();
    const other = newRide();
    await DispatchService.reserveDriver(d1, mine); // reserved by me
    await DispatchService.reserveDriver(d2, other); // reserved by another ride
    // d3 free
    const eligible = await DispatchService.filterUnreserved([d1, d2, d3], mine);
    expect(eligible.sort()).toEqual([d1, d3].sort()); // d2 excluded
  });
});

describe('release lifecycle', () => {
  it('H — reject: releaseDriver frees the driver for another ride immediately', async () => {
    const d = newDriver();
    const rideA = newRide();
    const rideB = newRide();
    await DispatchService.reserveDriver(d, rideA);

    // Wrong owner cannot release.
    expect(await DispatchService.releaseDriver(d, rideB)).toBe(false);
    expect(await reservationOwner(d)).toBe(rideA);

    // Owner releases → driver becomes reservable by B.
    expect(await DispatchService.releaseDriver(d, rideA)).toBe(true);
    expect(await reservationOwner(d)).toBeNull();
    expect(await DispatchService.reserveDriver(d, rideB)).toBe(true);
  });

  it('I/J — timeout & cancel release the reservation (owner-scoped)', async () => {
    const d = newDriver();
    const ride = newRide();
    await DispatchService.reserveDriver(d, ride);
    // timeout/cancel both call releaseDriver(driverId, rideId)
    expect(await DispatchService.releaseDriver(d, ride)).toBe(true);
    expect(await reservationOwner(d)).toBeNull();
  });

  it('K — completion clears the reservation; driver stays available only if heartbeat is fresh', async () => {
    const dFresh = newDriver();
    const dStale = newDriver();
    const ride = newRide();
    await setHeartbeatFresh(dFresh);
    await DispatchService.reserveDriver(dFresh, ride);
    await DispatchService.reserveDriver(dStale, newRide());

    // completion path releases the reservation
    await DispatchService.releaseDriver(dFresh, ride);
    expect(await reservationOwner(dFresh)).toBeNull();

    // available again ONLY because heartbeat is fresh
    expect(await DispatchService.isDriverAvailable(dFresh)).toBe(true);
    await setHeartbeatExpired(dStale);
    expect(await DispatchService.isDriverAvailable(dStale)).toBe(false);
  });

  it('forced release (no rideId) always clears', async () => {
    const d = newDriver();
    await DispatchService.reserveDriver(d, newRide());
    expect(await DispatchService.releaseDriver(d)).toBe(true);
    expect(await reservationOwner(d)).toBeNull();
  });
});

describe('E — heartbeat eligibility gate', () => {
  it('fresh heartbeat is available; expired/offline is not', async () => {
    const d = newDriver();
    await setHeartbeatFresh(d);
    expect(await DispatchService.isDriverAvailable(d)).toBe(true);
    await setHeartbeatExpired(d);
    expect(await DispatchService.isDriverAvailable(d)).toBe(false);
  });
});

describe('G — accept arbitration (Redis ride-lock proxy for the atomic DB claim)', () => {
  it('only one of two simultaneous acquireRideLock calls wins', async () => {
    const ride = newRide();
    const [a, b] = await Promise.all([
      DispatchService.acquireRideLock(ride, newDriver()),
      DispatchService.acquireRideLock(ride, newDriver()),
    ]);
    expect([a, b].filter(Boolean).length).toBe(1);
  });
});

describe('L — per-passenger active-ride guard', () => {
  it('acquirePassengerActive lets only the first ride claim the slot', async () => {
    const p = newPassenger();
    const rideA = newRide();
    const rideB = newRide();
    expect(await DispatchService.acquirePassengerActive(p, rideA)).toBe(true);
    expect(await DispatchService.acquirePassengerActive(p, rideB)).toBe(false);
    expect(await DispatchService.getPassengerActive(p)).toBe(rideA);
  });

  it('releasing the slot lets the passenger start a new ride', async () => {
    const p = newPassenger();
    const rideA = newRide();
    await DispatchService.acquirePassengerActive(p, rideA);
    expect(await DispatchService.releasePassengerActive(p, rideA)).toBe(true);
    expect(await DispatchService.acquirePassengerActive(p, newRide())).toBe(true);
  });

  it('one passenger\'s slot never affects another passenger', async () => {
    const p1 = newPassenger();
    const p2 = newPassenger();
    await DispatchService.acquirePassengerActive(p1, newRide());
    expect(await DispatchService.acquirePassengerActive(p2, newRide())).toBe(true);
  });
});
