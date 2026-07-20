/**
 * TRUE concurrency tests for atomic driver reservation. Competing operations are
 * launched with Promise.all (not sequentially) and race-sensitive cases repeat
 * many times to surface nondeterministic defects. The core invariant asserted
 * everywhere: a single driver can never be reserved by two rides at once.
 */
import {
  DispatchService,
  newDriver,
  newPassenger,
  newRide,
  reservationOwner,
  reservedCount,
  dispatchReserveOne,
  redis,
} from '../helpers/dispatch';

const REPEATS = 50;

async function freshRedis() {
  await (redis as any).flushall();
}

describe('D — atomic contention for one driver', () => {
  it('exactly one of N simultaneous reservations wins (x' + REPEATS + ')', async () => {
    for (let i = 0; i < REPEATS; i++) {
      await freshRedis();
      const driver = newDriver();
      const rides = Array.from({ length: 8 }, () => newRide());
      const results = await Promise.all(rides.map((r) => DispatchService.reserveDriver(driver, r)));
      expect(results.filter(Boolean).length).toBe(1);
      // The winner is the sole owner.
      const owner = await reservationOwner(driver);
      const winnerRide = rides[results.findIndex(Boolean)];
      expect(owner).toBe(winnerRide);
    }
  });
});

describe('A — two passengers, two available drivers', () => {
  it('both rides dispatch concurrently to SEPARATE drivers (x' + REPEATS + ')', async () => {
    for (let i = 0; i < REPEATS; i++) {
      await freshRedis();
      const drivers = [newDriver(), newDriver()];
      const rideA = newRide();
      const rideB = newRide();

      const [gotA, gotB] = await Promise.all([
        dispatchReserveOne(rideA, drivers),
        dispatchReserveOne(rideB, drivers),
      ]);

      expect(gotA).not.toBeNull();
      expect(gotB).not.toBeNull();
      expect(gotA).not.toBe(gotB); // distinct drivers — no double-ring
      // Each driver owned by exactly the ride that reserved it.
      expect(await reservationOwner(gotA as string)).toBe(rideA);
      expect(await reservationOwner(gotB as string)).toBe(rideB);
    }
  });
});

describe('B — two passengers, one driver', () => {
  it('only one ride reserves the driver; the other gets none (x' + REPEATS + ')', async () => {
    for (let i = 0; i < REPEATS; i++) {
      await freshRedis();
      const driver = newDriver();
      const rideA = newRide();
      const rideB = newRide();

      const [gotA, gotB] = await Promise.all([
        dispatchReserveOne(rideA, [driver]),
        dispatchReserveOne(rideB, [driver]),
      ]);

      const winners = [gotA, gotB].filter((x) => x === driver);
      expect(winners.length).toBe(1); // exactly one got the driver
      expect(await reservedCount([driver])).toBe(1);
    }
  });
});

describe('C — three passengers, two drivers', () => {
  it('no driver is ever reserved by two rides; at most 2 rides succeed (x' + REPEATS + ')', async () => {
    for (let i = 0; i < REPEATS; i++) {
      await freshRedis();
      const drivers = [newDriver(), newDriver()];
      const rides = [newRide(), newRide(), newRide()];

      const got = await Promise.all(rides.map((r) => dispatchReserveOne(r, drivers)));
      const assigned = got.filter((g): g is string => g != null);

      // At most 2 rides can win (only 2 drivers).
      expect(assigned.length).toBeLessThanOrEqual(2);
      // No driver assigned to two rides.
      expect(new Set(assigned).size).toBe(assigned.length);
      // Redis agrees: each driver reserved at most once.
      expect(await reservedCount(drivers)).toBe(assigned.length);
    }
  });
});

describe('L — same passenger submits two simultaneous requests', () => {
  it('only one active-ride slot is granted (x' + REPEATS + ')', async () => {
    for (let i = 0; i < REPEATS; i++) {
      await freshRedis();
      const p = newPassenger();
      const rides = [newRide(), newRide()];
      const results = await Promise.all(rides.map((r) => DispatchService.acquirePassengerActive(p, r)));
      expect(results.filter(Boolean).length).toBe(1);
    }
  });
});

describe('reject/timeout releases free the driver for the next ride under load', () => {
  it('after release, a previously-blocked ride can immediately reserve (x' + REPEATS + ')', async () => {
    for (let i = 0; i < REPEATS; i++) {
      await freshRedis();
      const driver = newDriver();
      const rideA = newRide();
      const rideB = newRide();

      await DispatchService.reserveDriver(driver, rideA);
      expect(await DispatchService.reserveDriver(driver, rideB)).toBe(false);

      // A rejects/times out → releases.
      await DispatchService.releaseDriver(driver, rideA);
      // B can now win the driver.
      expect(await DispatchService.reserveDriver(driver, rideB)).toBe(true);
      expect(await reservationOwner(driver)).toBe(rideB);
    }
  });
});
