/**
 * Data access for driver operational presence.
 *
 * Postgres is the source of truth. Redis is used only as a read-through cache
 * for the single-driver lookup, which the dispatcher board hits repeatedly —
 * and every Redis path degrades to Postgres on failure rather than erroring,
 * because a cache outage must not make it impossible to see where drivers are.
 */
import { In, Repository } from 'typeorm';
import { AppDataSource } from '../config/data_source';
import { DriverPresence, DriverPresenceState } from '../models/DriverPresence';
import { DriverPresenceEvent } from '../models/DriverPresenceEvent';
import { redis } from '../config/redis';

const CACHE_PREFIX = 'presence:driver:';
const CACHE_TTL_SECONDS = 60;

export interface PresenceListQuery {
    parkId?: string;
    states?: DriverPresenceState[];
    driverIds?: string[];
    page?: number;
    pageSize?: number;
}

export class DriverPresenceRepository {
    private static get repo(): Repository<DriverPresence> {
        return AppDataSource.getRepository(DriverPresence);
    }

    private static get events(): Repository<DriverPresenceEvent> {
        return AppDataSource.getRepository(DriverPresenceEvent);
    }

    static cacheKey(driverId: string): string {
        return `${CACHE_PREFIX}${driverId}`;
    }

    /** Read one driver's presence, preferring the cache. */
    static async find(driverId: string): Promise<DriverPresence | null> {
        try {
            const cached = await redis.get(this.cacheKey(driverId));
            if (cached) {
                const parsed = JSON.parse(cached);
                // Dates survive JSON as strings; rehydrate the two that are read.
                parsed.since = parsed.since ? new Date(parsed.since) : null;
                parsed.lastHeartbeatAt = parsed.lastHeartbeatAt ? new Date(parsed.lastHeartbeatAt) : null;
                return parsed as DriverPresence;
            }
        } catch {
            /* a cache miss and a cache outage are the same thing to the caller */
        }

        const row = await this.repo.findOneBy({ driverId });
        if (row) void this.cache(row);
        return row;
    }

    /** Authoritative read that bypasses the cache. Used before every write. */
    static findFresh(driverId: string): Promise<DriverPresence | null> {
        return this.repo.findOneBy({ driverId });
    }

    static async cache(presence: DriverPresence): Promise<void> {
        try {
            await redis.set(this.cacheKey(presence.driverId), JSON.stringify(presence), 'EX', CACHE_TTL_SECONDS);
        } catch {
            /* the cache is an optimisation, never a requirement */
        }
    }

    static async invalidate(driverId: string): Promise<void> {
        try {
            await redis.del(this.cacheKey(driverId));
        } catch {
            /* TTL is the backstop */
        }
    }

    static create(data: Partial<DriverPresence>): DriverPresence {
        return this.repo.create(data);
    }

    static async save(presence: DriverPresence): Promise<DriverPresence> {
        const saved = await this.repo.save(presence);
        await this.cache(saved);
        return saved;
    }

    /** Presence for many drivers in one query. The roster view's main read. */
    static async findMany(driverIds: string[]): Promise<Map<string, DriverPresence>> {
        if (driverIds.length === 0) return new Map();
        const rows = await this.repo.find({ where: { driverId: In(driverIds) } });
        return new Map(rows.map((r) => [r.driverId, r]));
    }

    static async list(query: PresenceListQuery): Promise<{ items: DriverPresence[]; total: number; page: number; pageSize: number }> {
        const page = Math.max(1, Math.floor(query.page ?? 1));
        const pageSize = Math.min(200, Math.max(1, Math.floor(query.pageSize ?? 50)));

        const qb = this.repo.createQueryBuilder('p');
        if (query.parkId) qb.andWhere('p."parkId" = :parkId', { parkId: query.parkId });
        if (query.states?.length) qb.andWhere('p.state IN (:...states)', { states: query.states });
        if (query.driverIds?.length) qb.andWhere('p."driverId" IN (:...driverIds)', { driverIds: query.driverIds });

        // Oldest-first within a state: the driver who has been waiting longest
        // is the one a dispatcher needs to see at the top.
        qb.orderBy('p.since', 'ASC').skip((page - 1) * pageSize).take(pageSize);
        const [items, total] = await qb.getManyAndCount();
        return { items, total, page, pageSize };
    }

    /** Everyone at a park in the given states, longest-waiting first. */
    static findAtPark(parkId: string, states: DriverPresenceState[]): Promise<DriverPresence[]> {
        return this.repo.find({
            where: { parkId, state: In(states) },
            order: { since: 'ASC' },
        });
    }

    // ── transition history ──────────────────────────────────────────────

    static recordEvent(data: Partial<DriverPresenceEvent>): Promise<DriverPresenceEvent> {
        return this.events.save(this.events.create(data));
    }

    static history(driverId: string, limit = 50): Promise<DriverPresenceEvent[]> {
        return this.events.find({
            where: { driverId },
            order: { occurredAt: 'DESC' },
            take: Math.min(500, Math.max(1, limit)),
        });
    }

    static parkHistory(parkId: string, since: Date, limit = 200): Promise<DriverPresenceEvent[]> {
        return this.events.createQueryBuilder('e')
            .where('e."parkId" = :parkId', { parkId })
            .andWhere('e."occurredAt" >= :since', { since })
            .orderBy('e."occurredAt"', 'DESC')
            .take(Math.min(1000, Math.max(1, limit)))
            .getMany();
    }

    /**
     * Time each driver has spent in their current state, for the ops board.
     * Computed in SQL so a two-hundred-driver park is one query.
     */
    static async dwellTimes(parkId: string): Promise<Array<{ driverId: string; state: DriverPresenceState; seconds: number }>> {
        const rows = await this.repo.createQueryBuilder('p')
            .select('p."driverId"', 'driverId')
            .addSelect('p.state', 'state')
            .addSelect('EXTRACT(EPOCH FROM (now() - p.since))', 'seconds')
            .where('p."parkId" = :parkId', { parkId })
            .orderBy('p.since', 'ASC')
            .getRawMany<{ driverId: string; state: DriverPresenceState; seconds: string }>();
        return rows.map((r) => ({ driverId: r.driverId, state: r.state, seconds: Math.round(Number(r.seconds)) }));
    }
}
