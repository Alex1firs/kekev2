/**
 * Data access for dispatcher shifts.
 *
 * The interesting queries here are the two "who is on duty" reads, which the
 * dispatcher dashboard and every future park-dispatch authorisation check will
 * make on a hot path. Both are single indexed lookups against
 * (staffUserId, status) and (parkId, status).
 */
import { IsNull, LessThan, Repository } from 'typeorm';
import { AppDataSource } from '../config/data_source';
import { DispatcherShift, DispatcherShiftStatus } from '../models/DispatcherShift';

export interface ShiftListQuery {
    parkId?: string;
    staffUserId?: string;
    status?: DispatcherShiftStatus;
    from?: Date;
    to?: Date;
    page?: number;
    pageSize?: number;
}

export class DispatcherShiftRepository {
    private static get repo(): Repository<DispatcherShift> {
        return AppDataSource.getRepository(DispatcherShift);
    }

    static findById(shiftId: string): Promise<DispatcherShift | null> {
        return this.repo.findOneBy({ shiftId });
    }

    /**
     * The dispatcher's currently open shift, anywhere.
     *
     * Not scoped to a park on purpose: a dispatcher may hold at most one open
     * shift in total, so "do they have one" is the question, and asking it
     * per-park would let a stale shift at park A silently permit work at park B.
     */
    static findOpenForStaff(staffUserId: string): Promise<DispatcherShift | null> {
        return this.repo.findOneBy({ staffUserId, status: DispatcherShiftStatus.OPEN });
    }

    /** Everyone currently on duty at a park. Ordered by who started first. */
    static findOpenAtPark(parkId: string): Promise<DispatcherShift[]> {
        return this.repo.find({
            where: { parkId, status: DispatcherShiftStatus.OPEN },
            order: { startedAt: 'ASC' },
        });
    }

    /** Open shifts across every park, for the operations overview. */
    static findAllOpen(): Promise<DispatcherShift[]> {
        return this.repo.find({
            where: { status: DispatcherShiftStatus.OPEN },
            order: { startedAt: 'ASC' },
        });
    }

    static async list(query: ShiftListQuery): Promise<{ items: DispatcherShift[]; total: number; page: number; pageSize: number }> {
        const page = Math.max(1, Math.floor(query.page ?? 1));
        const pageSize = Math.min(200, Math.max(1, Math.floor(query.pageSize ?? 50)));

        const qb = this.repo.createQueryBuilder('s');
        if (query.parkId) qb.andWhere('s."parkId" = :parkId', { parkId: query.parkId });
        if (query.staffUserId) qb.andWhere('s."staffUserId" = :staffUserId', { staffUserId: query.staffUserId });
        if (query.status) qb.andWhere('s.status = :status', { status: query.status });
        if (query.from) qb.andWhere('s."startedAt" >= :from', { from: query.from });
        if (query.to) qb.andWhere('s."startedAt" <= :to', { to: query.to });

        qb.orderBy('s."startedAt"', 'DESC').skip((page - 1) * pageSize).take(pageSize);
        const [items, total] = await qb.getManyAndCount();
        return { items, total, page, pageSize };
    }

    static create(data: Partial<DispatcherShift>): DispatcherShift {
        return this.repo.create(data);
    }

    static save(shift: DispatcherShift): Promise<DispatcherShift> {
        return this.repo.save(shift);
    }

    /**
     * Close a shift only if it is still open.
     *
     * A conditional UPDATE rather than a read-then-write: two supervisors
     * force-closing the same abandoned shift at once would otherwise both
     * succeed, and the second would overwrite the first one's reason. Returns
     * whether THIS caller performed the close.
     */
    static async closeIfOpen(
        shiftId: string,
        patch: Partial<DispatcherShift>,
    ): Promise<boolean> {
        const result = await this.repo.createQueryBuilder()
            .update()
            .set({ status: DispatcherShiftStatus.CLOSED, ...patch })
            .where('"shiftId" = :shiftId AND status = :open', {
                shiftId,
                open: DispatcherShiftStatus.OPEN,
            })
            .execute();
        return (result.affected ?? 0) > 0;
    }

    /**
     * Shifts left open past a cutoff — candidates for the abandonment sweep.
     *
     * Nothing calls this automatically yet. It exists so the operations screen
     * can show "3 shifts never closed" rather than that fact only surfacing when
     * somebody notices a dispatcher has been on duty for two days.
     */
    static findStaleOpen(olderThan: Date): Promise<DispatcherShift[]> {
        return this.repo.find({
            where: { status: DispatcherShiftStatus.OPEN, startedAt: LessThan(olderThan), endedAt: IsNull() },
            order: { startedAt: 'ASC' },
            take: 200,
        });
    }

    /** Aggregate shift statistics for a park, for the supervisor view. */
    static async statsForPark(parkId: string, since: Date): Promise<{
        shiftCount: number;
        totalMinutes: number;
        abandonedCount: number;
        unverifiedStartCount: number;
    }> {
        const row = await this.repo.createQueryBuilder('s')
            .select('COUNT(*)', 'shiftCount')
            .addSelect(`COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(s."endedAt", now()) - s."startedAt")) / 60), 0)`, 'totalMinutes')
            .addSelect(`COUNT(*) FILTER (WHERE s.status = 'abandoned')`, 'abandonedCount')
            .addSelect(`COUNT(*) FILTER (WHERE s."startLocationVerified" = false)`, 'unverifiedStartCount')
            .where('s."parkId" = :parkId', { parkId })
            .andWhere('s."startedAt" >= :since', { since })
            .getRawOne<{ shiftCount: string; totalMinutes: string; abandonedCount: string; unverifiedStartCount: string }>();

        return {
            shiftCount: Number(row?.shiftCount ?? 0),
            totalMinutes: Math.round(Number(row?.totalMinutes ?? 0)),
            abandonedCount: Number(row?.abandonedCount ?? 0),
            unverifiedStartCount: Number(row?.unverifiedStartCount ?? 0),
        };
    }
}
