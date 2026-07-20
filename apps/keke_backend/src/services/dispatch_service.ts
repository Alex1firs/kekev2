import { redis } from '../config/redis';

export class DispatchService {
  private static readonly DRIVER_GEO_KEY = 'drivers:locations';
  private static readonly DRIVER_AVAILABILITY_PREFIX = 'driver:available:';
  private static readonly DRIVER_LASTSEEN_PREFIX = 'driver:lastseen:';
  // Tombstone written when a driver DELIBERATELY goes offline (or is ejected),
  // so admin tooling can show them as Offline immediately instead of lingering
  // as "recently seen". Cleared on the next heartbeat.
  private static readonly DRIVER_OFFLINE_PREFIX = 'driver:offline:';
  // Availability freshness window: 45s allows 3 missed 12s heartbeats.
  static readonly AVAILABILITY_TTL_SECONDS = 45;
  // How long we remember a driver's last heartbeat after they go stale, so the
  // admin Live Riders dashboard can show "last seen N min ago" for offline
  // drivers. Not used for dispatch — availability is still the 45s key above.
  private static readonly LASTSEEN_TTL_SECONDS = 24 * 60 * 60;

  /**
   * Update driver location and reset heartbeat TTL
   */
  static async updateDriverLocation(driverId: string, lat: number, lng: number) {
    const pipeline = redis.pipeline();

    // 1. Update GEO location
    pipeline.geoadd(this.DRIVER_GEO_KEY, lng, lat, driverId);

    // 2. Set/Reset Availability Heartbeat (TTL 45s — allows 3 missed 12s heartbeats)
    const availabilityKey = `${this.DRIVER_AVAILABILITY_PREFIX}${driverId}`;
    pipeline.set(availabilityKey, 'true', 'EX', this.AVAILABILITY_TTL_SECONDS);

    // 3. Persistent last-seen timestamp (outlives the availability key) so admin
    // tooling can distinguish "recently seen / stale" from "never online".
    pipeline.set(`${this.DRIVER_LASTSEEN_PREFIX}${driverId}`, Date.now().toString(), 'EX', this.LASTSEEN_TTL_SECONDS);

    // 4. An active heartbeat clears any deliberate-offline tombstone.
    pipeline.del(`${this.DRIVER_OFFLINE_PREFIX}${driverId}`);

    await pipeline.exec();
  }

  /**
   * Explicitly remove driver from availability pool when toggling offline
   */
  static async removeDriverAvailability(driverId: string) {
    const pipeline = redis.pipeline();
    pipeline.zrem(this.DRIVER_GEO_KEY, driverId);
    pipeline.del(`${this.DRIVER_AVAILABILITY_PREFIX}${driverId}`);
    // Mark a deliberate offline so admin sees them Offline right away (not
    // "recently seen"). TTL matches last-seen so it self-expires.
    pipeline.set(`${this.DRIVER_OFFLINE_PREFIX}${driverId}`, Date.now().toString(), 'EX', this.LASTSEEN_TTL_SECONDS);
    await pipeline.exec();
  }

  /**
   * Find available drivers within radius
   */
  static async findNearbyDrivers(lat: number, lng: number, radiusKm: number, limit: number = 10): Promise<string[]> {
    // 1. Get potential candidates from GEO
    const nearby = await redis.georadius(
      this.DRIVER_GEO_KEY,
      lng,
      lat,
      radiusKm,
      'km',
      'ASC',
      'COUNT',
      limit * 2 // Fetch more to account for heartbeat filtering
    ) as string[];

    if (!nearby || nearby.length === 0) return [];

    // 2. Filter by heartbeat (Availability TTL)
    const availableDrivers: string[] = [];
    const keys = nearby.map(id => `${this.DRIVER_AVAILABILITY_PREFIX}${id}`);
    const availabilityValues = await redis.mget(...keys);

    for (let i = 0; i < nearby.length; i++) {
        if (availabilityValues[i] === 'true') {
            availableDrivers.push(nearby[i]);
            if (availableDrivers.length >= limit) break;
        }
    }

    return availableDrivers;
  }

  /**
   * Find available drivers within radius, returning their locations
   */
  static async getNearbyActiveDriversWithLocations(lat: number, lng: number, radiusKm: number, limit: number = 20): Promise<Array<{driverId: string, lat: number, lng: number}>> {
    // 1. Get potential candidates from GEO with coordinates
    const nearby = await redis.georadius(
      this.DRIVER_GEO_KEY,
      lng,
      lat,
      radiusKm,
      'km',
      'WITHCOORD',
      'ASC',
      'COUNT',
      limit * 2
    ) as Array<[string, [string, string]]>; // [member, [lng, lat]]

    if (!nearby || nearby.length === 0) return [];

    // 2. Filter by heartbeat (Availability TTL)
    const availableDrivers: Array<{driverId: string, lat: number, lng: number}> = [];
    const keys = nearby.map(entry => `${this.DRIVER_AVAILABILITY_PREFIX}${entry[0]}`);
    const availabilityValues = await redis.mget(...keys);

    for (let i = 0; i < nearby.length; i++) {
        if (availabilityValues[i] === 'true') {
            const driverId = nearby[i][0];
            const coords = nearby[i][1];
            availableDrivers.push({
                driverId,
                lng: parseFloat(coords[0]),
                lat: parseFloat(coords[1]),
            });
            if (availableDrivers.length >= limit) break;
        }
    }

    return availableDrivers;
  }

  /**
   * Concurrency Lock for Ride Acceptance
   */
  static async acquireRideLock(rideId: string, driverId: string): Promise<boolean> {
    const lockKey = `ride:${rideId}:lock`;
    // Correct ioredis order: key, value, mode, time, flag
    const result = await redis.set(lockKey, driverId, 'EX', 30, 'NX');
    return result === 'OK';
  }

  // ===================== Atomic driver reservation =====================
  // While a ride is ringing a candidate driver, that driver is temporarily
  // reserved so a SECOND concurrent ride cannot ring/assign the same driver and
  // instead skips to the next eligible one. The reservation is a soft lock with
  // a short TTL (self-healing backstop) plus explicit release on every terminal
  // event (reject / cancel / timeout / accept-elsewhere / complete).
  private static readonly DRIVER_RESERVED_PREFIX = 'driver:reserved:';
  // Matches the driver app's per-offer countdown so an unanswered offer frees
  // the driver for other rides automatically.
  static readonly RESERVATION_TTL_SECONDS = 30;
  // Release the key only if the caller still owns it — prevents one ride from
  // deleting a reservation that a different ride has since acquired.
  private static readonly RELEASE_IF_OWNER =
    "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

  static reservedKey(driverId: string): string {
    return `${this.DRIVER_RESERVED_PREFIX}${driverId}`;
  }

  /**
   * Atomically reserve a driver for a ride. Returns true only if THIS ride now
   * owns the reservation (SET NX). A driver already reserved by another ride
   * returns false so the caller skips to the next candidate.
   */
  static async reserveDriver(driverId: string, rideId: string): Promise<boolean> {
    const res = await redis.set(this.reservedKey(driverId), rideId, 'EX', this.RESERVATION_TTL_SECONDS, 'NX');
    return res === 'OK';
  }

  /** Who currently holds the reservation for this driver (or null). */
  static async getReservationOwner(driverId: string): Promise<string | null> {
    return await redis.get(this.reservedKey(driverId));
  }

  /**
   * Whether a driver has a fresh heartbeat (their availability key is still
   * alive). This is the same gate findNearbyDrivers applies after the GEO query,
   * exposed for reuse/testing. An offline or stale-heartbeat driver returns false
   * even if their app still shows "online".
   */
  static async isDriverAvailable(driverId: string): Promise<boolean> {
    return (await redis.get(`${this.DRIVER_AVAILABILITY_PREFIX}${driverId}`)) === 'true';
  }

  /**
   * Release a driver's reservation. When rideId is given, releases ONLY if that
   * ride still owns it (ownership-checked, atomic via Lua). When omitted, forces
   * release. Returns true if a key was actually removed.
   */
  static async releaseDriver(driverId: string, rideId?: string): Promise<boolean> {
    const key = this.reservedKey(driverId);
    if (!rideId) {
      const n = await redis.del(key);
      return Number(n) > 0;
    }
    const n = await redis.eval(this.RELEASE_IF_OWNER, 1, key, rideId) as number;
    return Number(n) === 1;
  }

  /**
   * From a candidate list, drop drivers currently reserved by a DIFFERENT ride.
   * Drivers that are free, or already reserved by forRideId, are kept.
   */
  static async filterUnreserved(driverIds: string[], forRideId: string): Promise<string[]> {
    if (driverIds.length === 0) return [];
    const vals = await redis.mget(...driverIds.map(id => this.reservedKey(id)));
    return driverIds.filter((_, i) => vals[i] == null || vals[i] === forRideId);
  }

  // ===================== Per-passenger active-ride guard =====================
  // Prevents ONE passenger from opening two concurrent rides. Redis NX makes the
  // check-and-set atomic even for two requests that arrive at the same instant;
  // the DB check (in the caller) covers state that outlives Redis. Scoped per
  // passenger — never blocks other passengers. Long TTL is only a backstop; the
  // key is released explicitly on every ride terminal.
  private static readonly PASSENGER_ACTIVE_PREFIX = 'passenger:active:';
  static readonly PASSENGER_ACTIVE_TTL_SECONDS = 3 * 60 * 60; // 3h backstop

  static passengerActiveKey(passengerId: string): string {
    return `${this.PASSENGER_ACTIVE_PREFIX}${passengerId}`;
  }

  /** Atomically claim the single active-ride slot for a passenger. */
  static async acquirePassengerActive(passengerId: string, rideId: string): Promise<boolean> {
    const res = await redis.set(this.passengerActiveKey(passengerId), rideId, 'EX', this.PASSENGER_ACTIVE_TTL_SECONDS, 'NX');
    return res === 'OK';
  }

  static async getPassengerActive(passengerId: string): Promise<string | null> {
    return await redis.get(this.passengerActiveKey(passengerId));
  }

  /** Release the passenger's active-ride slot (ownership-checked when rideId given). */
  static async releasePassengerActive(passengerId: string, rideId?: string): Promise<boolean> {
    const key = this.passengerActiveKey(passengerId);
    if (!rideId) {
      const n = await redis.del(key);
      return Number(n) > 0;
    }
    const n = await redis.eval(this.RELEASE_IF_OWNER, 1, key, rideId) as number;
    return Number(n) === 1;
  }
}
