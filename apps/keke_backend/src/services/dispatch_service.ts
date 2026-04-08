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

    // 2. Set/Reset Availability Heartbeat (TTL 30s)
    const availabilityKey = `${this.DRIVER_AVAILABILITY_PREFIX}${driverId}`;
    pipeline.set(availabilityKey, 'true', 'EX', 30);

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
   * Concurrency Lock for Ride Acceptance
   */
  static async acquireRideLock(rideId: string, driverId: string): Promise<boolean> {
    const lockKey = `ride:${rideId}:lock`;
    // Correct ioredis order: key, value, mode, time, flag
    const result = await redis.set(lockKey, driverId, 'EX', 30, 'NX');
    return result === 'OK';
  }
}
