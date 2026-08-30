import { redis } from '../config/redis';

export class DispatchService {
  private static readonly DRIVER_GEO_KEY = 'drivers:locations';
  private static readonly DRIVER_AVAILABILITY_PREFIX = 'driver:available:';
  /*
   * Public so the active-ride endpoints can report GPS freshness. Exposing the
   * key rather than duplicating the string keeps one definition — a second copy
   * would drift the first time the prefix changed and would fail silently, as a
   * lookup that always returns null.
   */
  static readonly DRIVER_LASTSEEN_PREFIX = 'driver:lastseen:';
  /**
   * Last known position, kept AFTER a driver goes offline.
   *
   * Separate from the geo index on purpose. `drivers:locations` is live,
   * dispatch-eligible presence and a driver going offline is zrem'd out of it
   * — that must not change, or an offline driver could be dispatched to.
   *
   * But Operations needs to ring the drivers who are near a stranded
   * passenger, and "6 registered nearby, 0 online" is unanswerable without a
   * position for the offline ones. This key holds that, with the same 24h life
   * as last-seen, and is NEVER consulted by dispatch or eligibility.
   */
  static readonly DRIVER_LASTPOS_PREFIX = 'driver:lastpos:';
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

    // 4. Last KNOWN position, which outlives going offline. Written on the
    // same pipeline so it costs no extra round trip and can never drift from
    // the geo entry. Read only by Operations, never by dispatch.
    pipeline.set(
      `${this.DRIVER_LASTPOS_PREFIX}${driverId}`,
      JSON.stringify({ lat, lng, at: Date.now() }),
      'EX',
      this.LASTSEEN_TTL_SECONDS,
    );

    // 5. An active heartbeat clears any deliberate-offline tombstone.
    pipeline.del(`${this.DRIVER_OFFLINE_PREFIX}${driverId}`);

    await pipeline.exec();
  }

  /**
   * Last known positions for a set of drivers, including offline ones.
   *
   * STALE INTELLIGENCE, and labelled as such everywhere it surfaces. A
   * position from 40 minutes ago says where a driver was, not where they are,
   * and must never be presented as current GPS or used to make somebody
   * dispatch-eligible. It exists so a dispatcher can decide who is worth
   * ringing.
   */
  static async lastKnownPositions(
    driverIds: string[],
  ): Promise<Map<string, { lat: number; lng: number; at: number }>> {
    const out = new Map<string, { lat: number; lng: number; at: number }>();
    if (driverIds.length === 0) return out;
    try {
      const raw = await redis.mget(...driverIds.map((id) => `${this.DRIVER_LASTPOS_PREFIX}${id}`));
      driverIds.forEach((id, i) => {
        const v = raw[i];
        if (!v) return;
        try {
          const parsed = JSON.parse(v);
          if (Number.isFinite(parsed?.lat) && Number.isFinite(parsed?.lng)) {
            out.set(id, { lat: parsed.lat, lng: parsed.lng, at: Number(parsed.at) || 0 });
          }
        } catch { /* a malformed entry is simply absent */ }
      });
    } catch (err: any) {
      // Redis down means no last-known intelligence, which degrades the
      // driver list to "online only" — it must never fail the request.
      console.warn(`[DISPATCH] lastKnownPositions failed: ${err?.message}`);
    }
    return out;
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
    // Deliberately does NOT clear driver:lastpos — that is the whole point of
    // keeping it separate from the geo index. Live presence disappears; where
    // they last were does not.
    await pipeline.exec();
  }

  /**
   * Live positions for a set of drivers, straight from the geo index.
   *
   * Deliberately the LIVE index (`drivers:locations`), never `driver:lastpos`.
   * Geographic eligibility must be decided on where a driver is, not where they
   * were forty minutes ago — a stale fix is intelligence for a dispatcher
   * deciding who to ring, and was never allowed to make anyone dispatchable.
   *
   * One pipelined call for the whole batch. Drivers with no live entry are
   * simply absent from the map; the caller must not read that as "elsewhere".
   */
  static async livePositions(
    driverIds: string[],
  ): Promise<Map<string, { lat: number; lng: number }>> {
    const out = new Map<string, { lat: number; lng: number }>();
    if (driverIds.length === 0) return out;

    const raw = (await redis.geopos(this.DRIVER_GEO_KEY, ...driverIds)) as Array<[string, string] | null>;
    for (let i = 0; i < driverIds.length; i += 1) {
      const pos = raw?.[i];
      if (!pos) continue;
      const lng = Number(pos[0]);
      const lat = Number(pos[1]);
      if (Number.isFinite(lat) && Number.isFinite(lng)) out.set(driverIds[i], { lat, lng });
    }
    return out;
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
   * Nearest-first available drivers WITH their distance from the pickup point.
   *
   * Same heartbeat gate as findNearbyDrivers; the distance is carried through so
   * dispatch can log how far each candidate actually was.
   */
  static async findNearbyDriversWithDistance(
    lat: number,
    lng: number,
    radiusKm: number,
    limit: number = 10,
  ): Promise<Array<{ driverId: string; distanceKm: number | null }>> {
    let nearby: Array<[string, string]> = [];
    try {
      nearby = (await redis.georadius(
        this.DRIVER_GEO_KEY,
        lng,
        lat,
        radiusKm,
        'km',
        'WITHDIST',
        'ASC',
        'COUNT',
        limit * 2,
      )) as unknown as Array<[string, string]>;
    } catch {
      // WITHDIST unsupported (some Redis-compatible backends) — fall back to the
      // plain query and report unknown distances rather than failing dispatch.
      const ids = await this.findNearbyDrivers(lat, lng, radiusKm, limit);
      return ids.map((driverId) => ({ driverId, distanceKm: null }));
    }

    if (!nearby || nearby.length === 0) return [];

    const ids = nearby.map((entry) => (Array.isArray(entry) ? entry[0] : (entry as unknown as string)));
    const availability = await redis.mget(...ids.map((id) => `${this.DRIVER_AVAILABILITY_PREFIX}${id}`));

    const out: Array<{ driverId: string; distanceKm: number | null }> = [];
    for (let i = 0; i < ids.length; i++) {
      if (availability[i] !== 'true') continue;
      const entry = nearby[i];
      const raw = Array.isArray(entry) ? parseFloat(entry[1]) : NaN;
      out.push({ driverId: ids[i], distanceKm: Number.isFinite(raw) ? raw : null });
      if (out.length >= limit) break;
    }
    return out;
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
  /**
   * Forget that a driver was deliberately offline.
   *
   * Called when intent flips back to ONLINE, so admin tooling stops showing a
   * driver as Offline the instant they say they are working — rather than
   * waiting for their first heartbeat, which on a stale device may be a
   * wake-push away.
   */
  static async clearOfflineTombstone(driverId: string): Promise<void> {
    await redis.del(`${this.DRIVER_OFFLINE_PREFIX}${driverId}`);
  }

  static async isDriverAvailable(driverId: string): Promise<boolean> {
    return (await redis.get(`${this.DRIVER_AVAILABILITY_PREFIX}${driverId}`)) === 'true';
  }

  /**
   * Whether the driver DELIBERATELY went offline (tombstone written by
   * removeDriverAvailability, cleared by the next heartbeat).
   *
   * Distinct from a stale heartbeat: a driver who chose to stop working must not
   * be dragged back into the dispatch pool by ride cleanup.
   */
  static async isDriverDeliberatelyOffline(driverId: string): Promise<boolean> {
    return (await redis.exists(`${this.DRIVER_OFFLINE_PREFIX}${driverId}`)) === 1;
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

  // ===================== Searching-ride context (read-only mirror) ===========
  // The orchestrator publishes which round and radius tier a searching ride is
  // currently on. The passenger's nearby-Keke map feed reads it so its markers
  // reflect the SAME search area dispatch is actually working, instead of a
  // second, independently-chosen radius.
  //
  // Server-side state on purpose: a client cannot widen its own search area by
  // asking for a bigger radius. Writing it changes no dispatch behaviour.
  private static readonly SEARCH_CONTEXT_PREFIX = 'ride:search_context:';
  private static readonly SEARCH_CONTEXT_TTL_SECONDS = 180;

  static searchContextKey(rideId: string): string {
    return `${this.SEARCH_CONTEXT_PREFIX}${rideId}`;
  }

  static async publishSearchContext(ctx: {
    rideId: string;
    dispatchRound: number;
    radiusKm: number;
    lat: number;
    lng: number;
    updatedAt: number;
  }): Promise<void> {
    await redis.set(
      this.searchContextKey(ctx.rideId),
      JSON.stringify(ctx),
      'EX',
      this.SEARCH_CONTEXT_TTL_SECONDS,
    );
  }

  static async getSearchContext(rideId: string): Promise<{
    rideId: string;
    dispatchRound: number;
    radiusKm: number;
    lat: number;
    lng: number;
    updatedAt: number;
  } | null> {
    const raw = await redis.get(this.searchContextKey(rideId));
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  static async clearSearchContext(rideId: string): Promise<void> {
    await redis.del(this.searchContextKey(rideId));
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

  /**
   * How long the passenger's active-ride slot has been held, in ms.
   *
   * Derived from the key's remaining TTL, so it needs no extra bookkeeping and
   * cannot be skewed by a wrong client clock (ride ids are client-generated).
   * Returns null when no slot is held.
   *
   * Used to tell a genuine in-flight sibling request — milliseconds old, whose
   * ride row simply isn't committed yet — from an orphaned slot left behind by
   * a crash or an early return.
   */
  static async getPassengerActiveAgeMs(passengerId: string): Promise<number | null> {
    const ttlMs = await redis.pttl(this.passengerActiveKey(passengerId));
    if (typeof ttlMs !== 'number' || ttlMs <= 0) return null;
    return Math.max(0, this.PASSENGER_ACTIVE_TTL_SECONDS * 1000 - ttlMs);
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
