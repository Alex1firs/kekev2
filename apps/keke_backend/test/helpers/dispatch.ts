/**
 * Reusable helpers for reservation / dispatch tests. All operate on the mocked
 * Redis (see test/mocks/redis.ts) and the real DispatchService reservation code.
 */
import { redis } from '../../src/config/redis';
import { DispatchService } from '../../src/services/dispatch_service';

let seq = 0;
export const uid = (prefix: string): string => `${prefix}_${++seq}_${Math.floor(Math.random() * 1e6)}`;
export const newDriver = () => uid('driver');
export const newPassenger = () => uid('passenger');
export const newRide = () => uid('RIDE');

/** Mark a driver as freshly online (availability key alive, like a heartbeat). */
export async function setHeartbeatFresh(driverId: string, ttlSec = DispatchService.AVAILABILITY_TTL_SECONDS): Promise<void> {
  await redis.set(`driver:available:${driverId}`, 'true', 'EX', ttlSec);
}

/** Mark a driver as offline / expired heartbeat. */
export async function setHeartbeatExpired(driverId: string): Promise<void> {
  await redis.del(`driver:available:${driverId}`);
}

/** Raw read of the reservation owner (bypasses the service). */
export async function reservationOwner(driverId: string): Promise<string | null> {
  return await redis.get(DispatchService.reservedKey(driverId));
}

/** Count how many of these drivers currently hold a reservation. */
export async function reservedCount(driverIds: string[]): Promise<number> {
  const vals = await redis.mget(...driverIds.map((id) => DispatchService.reservedKey(id)));
  return vals.filter((v) => v != null).length;
}

/**
 * Simulate one ride's dispatch attempt over a candidate pool: reserve the first
 * driver it can atomically win (skipping any already reserved by another ride).
 * Returns the driverId it reserved, or null if none were free. Mirrors the
 * per-tier logic in startDispatchLoop.
 */
export async function dispatchReserveOne(rideId: string, candidates: string[]): Promise<string | null> {
  const free = await DispatchService.filterUnreserved(candidates, rideId);
  for (const driverId of free) {
    const won = await DispatchService.reserveDriver(driverId, rideId);
    if (won) return driverId;
  }
  return null;
}

export { redis, DispatchService };
