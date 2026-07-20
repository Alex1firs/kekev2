/**
 * DB-level integration tests for the pieces of dispatch that are arbitrated by
 * Postgres (not Redis):
 *   - F: a driver already assigned to a ride (status accepted/arrived/in_progress)
 *        is excluded by the busy-filter query used in startDispatchLoop.
 *   - the per-passenger active-ride DB backstop finds an existing live ride.
 *
 * These require a DISPOSABLE Postgres. They are SKIPPED unless TEST_DATABASE_URL
 * is set, and the guard (test/setup/guard.ts) refuses prod-looking URLs. Never
 * point this at production. Uses synchronize:true on a throwaway database.
 */
import 'reflect-metadata';
import { DataSource, In } from 'typeorm';
import { Ride, RideStatus } from '../../src/models/Ride';
import { DriverProfile, DriverStatus } from '../../src/models/DriverProfile';
import { User, UserRole } from '../../src/models/User';

const TEST_DB = process.env.TEST_DATABASE_URL;
const describeDb = TEST_DB ? describe : describe.skip;

if (!TEST_DB) {
  // eslint-disable-next-line no-console
  console.warn('[integration] TEST_DATABASE_URL not set — skipping DB integration tests (F + passenger DB guard).');
}

describeDb('dispatch DB-level exclusions (F + passenger guard)', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = new DataSource({
      type: 'postgres',
      url: TEST_DB,
      entities: [Ride, DriverProfile, User],
      synchronize: true,
      dropSchema: true, // disposable: start clean
    });
    await ds.initialize();
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  const BUSY_STATES = [RideStatus.ACCEPTED, RideStatus.ARRIVED, RideStatus.IN_PROGRESS] as any[];
  const ACTIVE_STATES = [RideStatus.SEARCHING, RideStatus.ACCEPTED, RideStatus.ARRIVED, RideStatus.IN_PROGRESS, RideStatus.STARTED] as any[];

  it('F — a driver on an accepted ride is excluded by the busy-filter query', async () => {
    const rideRepo = ds.getRepository(Ride);
    const busyDriver = 'driver-busy-1';
    const freeDriver = 'driver-free-1';
    await rideRepo.save(rideRepo.create({
      rideId: 'RIDE-busy-1', passengerId: 'p1', fare: 1000,
      paymentMode: 'cash', status: RideStatus.ACCEPTED, driverId: busyDriver,
    } as any));

    const busy = await rideRepo.find({ where: { driverId: In([busyDriver, freeDriver]), status: In(BUSY_STATES) } });
    const busyIds = new Set(busy.map((r) => r.driverId));

    expect(busyIds.has(busyDriver)).toBe(true);
    expect(busyIds.has(freeDriver)).toBe(false);
  });

  it('passenger DB backstop finds an existing live ride for the same passenger only', async () => {
    const rideRepo = ds.getRepository(Ride);
    const passenger = 'passenger-active-1';
    await rideRepo.save(rideRepo.create({
      rideId: 'RIDE-active-1', passengerId: passenger, fare: 1500,
      paymentMode: 'wallet', status: RideStatus.SEARCHING,
    } as any));

    const existing = await rideRepo.findOne({ where: { passengerId: passenger, status: In(ACTIVE_STATES) } });
    expect(existing?.rideId).toBe('RIDE-active-1');

    const other = await rideRepo.findOne({ where: { passengerId: 'someone-else', status: In(ACTIVE_STATES) } });
    expect(other).toBeNull();
  });
});
