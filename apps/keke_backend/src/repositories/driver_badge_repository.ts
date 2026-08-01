/**
 * Data access for driver badges.
 *
 * `nextSerial` and short-code allocation both have to survive two operators
 * issuing badges at the same moment, so both are written to lose gracefully:
 * the database's partial unique indexes are the arbiter, and the service
 * retries on collision rather than pre-checking and hoping.
 */
import { In, Repository } from 'typeorm';
import { AppDataSource } from '../config/data_source';
import { DriverBadge, BadgeStatus } from '../models/DriverBadge';

/** Statuses in which a badge occupies its driver's slot and its short code. */
export const LIVE_BADGE_STATUSES = [BadgeStatus.ACTIVE, BadgeStatus.PENDING_ACTIVATION];

export interface BadgeListQuery {
    parkId?: string;
    status?: BadgeStatus;
    driverId?: string;
    search?: string;
    page?: number;
    pageSize?: number;
}

export class DriverBadgeRepository {
    private static get repo(): Repository<DriverBadge> {
        return AppDataSource.getRepository(DriverBadge);
    }

    static findBySerial(badgeSerial: string): Promise<DriverBadge | null> {
        return this.repo.findOneBy({ badgeSerial: badgeSerial.trim().toUpperCase() });
    }

    /** The badge a driver currently holds, if any. */
    static findLiveForDriver(driverId: string): Promise<DriverBadge | null> {
        return this.repo.findOne({ where: { driverId, status: In(LIVE_BADGE_STATUSES) } });
    }

    static findByShortCode(shortCode: string): Promise<DriverBadge | null> {
        return this.repo.findOne({ where: { shortCode, status: In(LIVE_BADGE_STATUSES) } });
    }

    static findByPublicId(driverPublicId: string): Promise<DriverBadge | null> {
        return this.repo.findOneBy({ driverPublicId });
    }

    static findManyForDrivers(driverIds: string[]): Promise<DriverBadge[]> {
        if (driverIds.length === 0) return Promise.resolve([]);
        return this.repo.find({ where: { driverId: In(driverIds), status: In(LIVE_BADGE_STATUSES) } });
    }

    static create(data: Partial<DriverBadge>): DriverBadge {
        return this.repo.create(data);
    }

    static save(badge: DriverBadge): Promise<DriverBadge> {
        return this.repo.save(badge);
    }

    static async list(query: BadgeListQuery): Promise<{ items: DriverBadge[]; total: number; page: number; pageSize: number }> {
        const page = Math.max(1, Math.floor(query.page ?? 1));
        const pageSize = Math.min(200, Math.max(1, Math.floor(query.pageSize ?? 50)));

        const qb = this.repo.createQueryBuilder('b');
        if (query.parkId) qb.andWhere('b."parkId" = :parkId', { parkId: query.parkId });
        if (query.status) qb.andWhere('b.status = :status', { status: query.status });
        if (query.driverId) qb.andWhere('b."driverId" = :driverId', { driverId: query.driverId });
        if (query.search?.trim()) {
            const term = `%${query.search.trim()}%`;
            qb.andWhere('(b."badgeSerial" ILIKE :term OR b."shortCode" ILIKE :term)', { term });
        }
        qb.orderBy('b."issuedAt"', 'DESC').skip((page - 1) * pageSize).take(pageSize);

        const [items, total] = await qb.getManyAndCount();
        return { items, total, page, pageSize };
    }

    /**
     * The next serial in the KR-nnnnnn sequence.
     *
     * Derived from the highest existing serial rather than a counter table.
     * Two concurrent issues can compute the same value; the primary key then
     * rejects the loser and BadgeService retries. That is cheaper and less
     * fragile than a lock, because badge issuance is a rare, human-paced act.
     */
    static async nextSerial(): Promise<string> {
        const row = await this.repo.createQueryBuilder('b')
            .select(`MAX(CAST(NULLIF(regexp_replace(b."badgeSerial", '\\D', '', 'g'), '') AS INTEGER))`, 'max')
            .getRawOne<{ max: string | null }>();
        const next = Number(row?.max ?? 0) + 1;
        return `KR-${String(next).padStart(6, '0')}`;
    }

    /** Whether a short code is currently taken by a live badge. */
    static async shortCodeTaken(shortCode: string): Promise<boolean> {
        const count = await this.repo.count({ where: { shortCode, status: In(LIVE_BADGE_STATUSES) } });
        return count > 0;
    }

    static async countsByStatus(): Promise<Record<string, number>> {
        const rows = await this.repo.createQueryBuilder('b')
            .select('b.status', 'status')
            .addSelect('COUNT(*)', 'count')
            .groupBy('b.status')
            .getRawMany<{ status: string; count: string }>();
        return Object.fromEntries(rows.map((r) => [r.status, Number(r.count)]));
    }
}
