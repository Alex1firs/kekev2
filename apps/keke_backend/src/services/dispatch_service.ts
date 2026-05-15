import { redis } from '../config/redis';

export class DispatchService {
  private static readonly DRIVER_GEO_KEY = 'drivers:locations';
  private static readonly DRIVER_AVAILABILITY_PREFIX = 'driver:available:';

  /**
   * Update driver location and reset heartbeat TTL
   */
  static async updateDriverLocation(driverId: string, lat: number, lng: number) {
    const pipeline = redis.pipeline();

    // 1. Update GEO location
    pipeline.geoadd(this.DRIVER_GEO_KEY, lng, lat, driverId);

    // 2. Set/Reset Availability Heartbeat (TTL 45s — allows 3 missed 12s heartbeats)
    const availabilityKey = `${this.DRIVER_AVAILABILITY_PREFIX}${driverId}`;
    pipeline.set(availabilityKey, 'true', 'EX', 45);

    await pipeline.exec();
  }

  /**
   * Explicitly remove driver from availability pool when toggling offline
   */
  static async removeDriverAvailability(driverId: string) {
    const pipeline = redis.pipeline();
    pipeline.zrem(this.DRIVER_GEO_KEY, driverId);
    pipeline.del(`${this.DRIVER_AVAILABILITY_PREFIX}${driverId}`);
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
}
