/**
 * Read side of the Ride Operations console.
 *
 * The console answers one question — "what actually happened to this ride?" —
 * for every ride ever requested, not just the ones in flight. It is the tool a
 * support agent has open when a passenger rings to ask why no Keke came.
 *
 * ## Relationship to the live monitor
 *
 * DispatchMonitorQueryService already composes the four tiers (live ledger,
 * persisted events, analytics, PII) for rides that are happening NOW. This
 * service is its historical counterpart and deliberately reuses it rather than
 * reimplementing it: `requestDetail` was always keyed by rideId alone and works
 * unchanged for terminal rides, and identity resolution comes from the same
 * `peopleFor`. There is no second definition of "who was the driver" here.
 *
 * What this adds is the LIST: server-side filtering, searching, paging and
 * aggregation over the whole ride table, which the live monitor never needed
 * because "live" is a handful of rows.
 *
 * ## Every query is bounded
 *
 * Nothing in here can return an unbounded result set. Page size is clamped, the
 * search path resolves identities before touching the ride table, and the
 * summary is computed as aggregates in Postgres. The browser never receives
 * more than one page of rides.
 */
import { Brackets, SelectQueryBuilder } from 'typeorm';
import { AppDataSource } from '../config/data_source';
import { Ride, RideStatus } from '../models/Ride';
import { User } from '../models/User';
import { DriverProfile } from '../models/DriverProfile';
import {
    DispatchMonitorQueryService,
    maskName,
    maskPhone,
    maskEmail,
    areaOf,
} from './dispatch_monitor_query_service';
import { outcomeLabel, classifyOutcome, RideOutcomeCode, resolveAreaLine } from './ride_outcome';

/** Hard ceiling on a page, whatever the caller asks for. */
const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 25;

/** Upper bound on identities a search term may expand to before we stop. */
const MAX_SEARCH_IDENTITIES = 500;

export interface RideOperationsFilters {
    /** ISO date-times. Inclusive lower bound, exclusive upper. */
    from?: string;
    to?: string;
    status?: string[];
    outcomeReason?: string[];
    cancelledByRole?: string[];
    /** Substring match against the captured pickup address. */
    pickupArea?: string;
    destinationArea?: string;
    passengerId?: string;
    driverId?: string;
    /** Free text: ride id, or a passenger/driver name, phone or email. */
    q?: string;
    page?: number;
    pageSize?: number;
}

export interface RideOperationsRow {
    rideId: string;
    requestedAt: string;
    status: string;
    outcomeReason: string | null;
    outcomeLabel: string;
    outcomeClass: string;
    outcomeRecorded: boolean;
    cancelledByRole: string | null;
    passenger: { id: string; name: string; phoneMasked: string | null } | null;
    driver: { id: string; name: string; phoneMasked: string | null } | null;
    pickupAddress: string | null;
    pickupArea: string | null;
    /** 'structured' = the geocoder named it; 'parsed' = derived from prose. */
    pickupAreaSource: 'structured' | 'parsed' | 'none';
    destinationAddress: string | null;
    destinationArea: string | null;
    destinationAreaSource: 'structured' | 'parsed' | 'none';
    fare: number | null;
    paymentMode: string | null;
    acceptanceSeconds: number | null;
}

export class RideOperationsService {
    /**
     * Expand a free-text term into the passenger/driver ids it could mean.
     *
     * Done as a separate step against `user` and `driver_profile` — both small
     * — so the ride query can then use the existing indexed `passengerId` /
     * `driverId` columns. The alternative, joining `user` into the ride query
     * and running ILIKE across it, cannot use an index on either side and gets
     * worse with every ride ever taken. This gets worse only with the number of
     * PEOPLE, which grows far more slowly.
     */
    private static async identitiesMatching(term: string): Promise<string[]> {
        const like = `%${term.trim()}%`;
        // Digits-only comparison so "0803 123 4567", "+2348031234567" and
        // "8031234567" all find the same person — support staff type a phone
        // number however the caller reads it out.
        const digits = term.replace(/\D/g, '');

        const userQb = AppDataSource.getRepository(User)
            .createQueryBuilder('u')
            .select('u.id', 'id')
            .where(
                new Brackets((qb) => {
                    qb.where('u."firstName" ILIKE :like', { like })
                        .orWhere('u."lastName" ILIKE :like', { like })
                        .orWhere(`(u."firstName" || ' ' || u."lastName") ILIKE :like`, { like })
                        .orWhere('u.email ILIKE :like', { like });
                    if (digits.length >= 4) {
                        qb.orWhere(`regexp_replace(u.phone, '\\D', '', 'g') LIKE :digits`, {
                            digits: `%${digits}%`,
                        });
                    }
                }),
            )
            .limit(MAX_SEARCH_IDENTITIES);

        // Driver names live on the profile, not only on the user row, and the
        // two can differ (a driver's KYC name is what operations sees).
        const driverQb = AppDataSource.getRepository(DriverProfile)
            .createQueryBuilder('d')
            .select('d.userId', 'id')
            .where(
                new Brackets((qb) => {
                    qb.where('d."firstName" ILIKE :like', { like })
                        .orWhere('d."lastName" ILIKE :like', { like })
                        .orWhere(`(d."firstName" || ' ' || d."lastName") ILIKE :like`, { like })
                        .orWhere('d."vehiclePlate" ILIKE :like', { like });
                }),
            )
            .limit(MAX_SEARCH_IDENTITIES);

        const [users, drivers] = await Promise.all([userQb.getRawMany(), driverQb.getRawMany()]);
        return [...new Set([...users, ...drivers].map((r) => String(r.id)))];
    }

    /** Apply every filter to a ride query builder. Shared by list and summary. */
    private static async applyFilters(
        qb: SelectQueryBuilder<Ride>,
        f: RideOperationsFilters,
    ): Promise<SelectQueryBuilder<Ride>> {
        if (f.from) qb.andWhere('r."createdAt" >= :from', { from: new Date(f.from) });
        if (f.to) qb.andWhere('r."createdAt" < :to', { to: new Date(f.to) });

        if (f.status?.length) qb.andWhere('r.status IN (:...statuses)', { statuses: f.status });

        if (f.outcomeReason?.length) {
            // A filter for "legacy / unrecorded" is a filter for NULL, which
            // cannot travel through an IN list. Handled explicitly so operations
            // can ask "which rides can't we explain?" — a real question when
            // judging how much of the history is trustworthy.
            const wantsLegacy = f.outcomeReason.includes(RideOutcomeCode.LEGACY_UNAVAILABLE);
            const concrete = f.outcomeReason.filter((c) => c !== RideOutcomeCode.LEGACY_UNAVAILABLE);
            qb.andWhere(
                new Brackets((b) => {
                    if (concrete.length) b.orWhere('r."outcomeReason" IN (:...codes)', { codes: concrete });
                    if (wantsLegacy) b.orWhere('r."outcomeReason" IS NULL');
                    if (!concrete.length && !wantsLegacy) b.where('1 = 0');
                }),
            );
        }

        if (f.cancelledByRole?.length) {
            qb.andWhere('r."cancelledByRole" IN (:...roles)', { roles: f.cancelledByRole });
        }

        if (f.pickupArea) {
            qb.andWhere('r."pickupAddress" ILIKE :pickupArea', { pickupArea: `%${f.pickupArea}%` });
        }
        if (f.destinationArea) {
            qb.andWhere('r."destinationAddress" ILIKE :destArea', { destArea: `%${f.destinationArea}%` });
        }

        if (f.passengerId) qb.andWhere('r."passengerId" = :pid', { pid: f.passengerId });
        if (f.driverId) qb.andWhere('r."driverId" = :did', { did: f.driverId });

        if (f.q?.trim()) {
            const term = f.q.trim();
            const ids = await this.identitiesMatching(term);
            qb.andWhere(
                new Brackets((b) => {
                    // A ride id is matched directly — support staff paste them
                    // from a passenger's screenshot.
                    b.where('r."rideId" ILIKE :ridelike', { ridelike: `%${term}%` });
                    if (ids.length) {
                        b.orWhere('r."passengerId" IN (:...sids)', { sids: ids })
                            .orWhere('r."driverId" IN (:...sids2)', { sids2: ids });
                    }
                }),
            );
        }

        return qb;
    }

    /** One page of rides, newest first, with identity and outcome resolved. */
    static async list(f: RideOperationsFilters): Promise<{
        rows: RideOperationsRow[];
        total: number;
        page: number;
        pageSize: number;
    }> {
        const pageSize = Math.min(Math.max(Number(f.pageSize) || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
        const page = Math.max(Number(f.page) || 1, 1);

        const qb = AppDataSource.getRepository(Ride).createQueryBuilder('r');
        await this.applyFilters(qb, f);

        const [rides, total] = await qb
            .orderBy('r."createdAt"', 'DESC')
            .skip((page - 1) * pageSize)
            .take(pageSize)
            .getManyAndCount();

        const people = await DispatchMonitorQueryService.peopleFor(rides);

        const rows: RideOperationsRow[] = rides.map((r) => {
            const p = people.passengers.get(r.passengerId);
            const d = r.driverId ? people.drivers.get(r.driverId) : undefined;
            const acceptedAt = r.acceptedAt ? new Date(r.acceptedAt).getTime() : null;
            const createdAt = new Date(r.createdAt).getTime();
            const pickupArea = resolveAreaLine(
                r.pickupSubLocality, r.pickupLocality, areaOf(r.pickupAddress));
            const destArea = resolveAreaLine(
                r.destinationSubLocality, r.destinationLocality, areaOf(r.destinationAddress));

            return {
                rideId: r.rideId,
                requestedAt: new Date(r.createdAt).toISOString(),
                status: String(r.status),
                outcomeReason: r.outcomeReason ?? null,
                outcomeLabel: outcomeLabel(r.outcomeReason),
                outcomeClass: classifyOutcome(r.outcomeReason as RideOutcomeCode | null),
                // Lets the UI style "we never recorded this" differently from a
                // known outcome, instead of showing an em dash for both.
                outcomeRecorded: r.outcomeReason != null,
                cancelledByRole: r.cancelledByRole ?? null,
                passenger: p
                    ? {
                          id: r.passengerId,
                          name: maskName(p.firstName, p.lastName),
                          phoneMasked: maskPhone(p.phone),
                      }
                    : null,
                driver: r.driverId
                    ? {
                          id: r.driverId,
                          name: maskName(d?.firstName, d?.lastName),
                          phoneMasked: maskPhone(people.driverPhones.get(r.driverId)),
                      }
                    : null,
                pickupAddress: r.pickupAddress ?? null,
                // Structured locality wins when the app captured it; the
                // address parse is the fallback for everything older.
                pickupArea: pickupArea.area,
                pickupAreaSource: pickupArea.source,
                destinationAddress: r.destinationAddress ?? null,
                destinationArea: destArea.area,
                destinationAreaSource: destArea.source,
                fare: r.finalFare != null ? Number(r.finalFare)
                    : r.fare != null ? Number(r.fare)
                    : null,
                paymentMode: r.paymentMode ?? null,
                acceptanceSeconds:
                    acceptedAt && Number.isFinite(createdAt)
                        ? Math.max(0, Math.round((acceptedAt - createdAt) / 1000))
                        : null,
            };
        });

        return { rows, total, page, pageSize };
    }

    /**
     * The cards above the table, computed in Postgres.
     *
     * Deliberately respects the SAME filters as the list, so the numbers always
     * describe the rows underneath them. A summary that silently ignored the
     * date filter would be worse than no summary at all.
     */
    static async summary(f: RideOperationsFilters): Promise<{
        requests: number;
        completed: number;
        failed: number;
        cancelled: number;
        noDriverAvailable: number;
        noDriverAccepted: number;
        technicalFailures: number;
        unexplained: number;
        avgAcceptanceSeconds: number | null;
        completionRate: number | null;
    }> {
        const qb = AppDataSource.getRepository(Ride).createQueryBuilder('r');
        await this.applyFilters(qb, f);

        const row = await qb
            .select('COUNT(*)', 'requests')
            .addSelect(`COUNT(*) FILTER (WHERE r.status = 'completed')`, 'completed')
            .addSelect(`COUNT(*) FILTER (WHERE r.status = 'failed')`, 'failed')
            .addSelect(`COUNT(*) FILTER (WHERE r.status = 'canceled')`, 'cancelled')
            .addSelect(
                `COUNT(*) FILTER (WHERE r."outcomeReason" = '${RideOutcomeCode.NO_ELIGIBLE_DRIVER}')`,
                'noDriverAvailable',
            )
            .addSelect(
                `COUNT(*) FILTER (WHERE r."outcomeReason" = '${RideOutcomeCode.NO_DRIVER_ACCEPTED}')`,
                'noDriverAccepted',
            )
            .addSelect(
                `COUNT(*) FILTER (WHERE r."outcomeReason" = '${RideOutcomeCode.TECHNICAL_FAILURE}')`,
                'technicalFailures',
            )
            // Terminal rides we cannot explain. Surfaced rather than hidden:
            // it is the honest measure of how far back the trail reaches.
            .addSelect(
                `COUNT(*) FILTER (WHERE r."outcomeReason" IS NULL
                                    AND r.status IN ('failed','canceled','completed'))`,
                'unexplained',
            )
            .addSelect(
                `AVG(EXTRACT(EPOCH FROM (r."acceptedAt" - r."createdAt")))
                   FILTER (WHERE r."acceptedAt" IS NOT NULL
                             AND r."acceptedAt" >= r."createdAt")`,
                'avgAcceptanceSeconds',
            )
            .getRawOne();

        const n = (v: unknown) => Number(v ?? 0);
        const requests = n(row?.requests);
        const completed = n(row?.completed);
        const avg = row?.avgAcceptanceSeconds;

        return {
            requests,
            completed,
            failed: n(row?.failed),
            cancelled: n(row?.cancelled),
            noDriverAvailable: n(row?.noDriverAvailable),
            noDriverAccepted: n(row?.noDriverAccepted),
            technicalFailures: n(row?.technicalFailures),
            unexplained: n(row?.unexplained),
            avgAcceptanceSeconds: avg == null ? null : Math.round(Number(avg)),
            completionRate: requests > 0 ? Number(((completed / requests) * 100).toFixed(1)) : null,
        };
    }

    /**
     * Distinct values for the filter dropdowns, drawn from the data that is
     * actually there — so an operator is never offered a filter that returns
     * nothing, and never misses one because it was not in a hardcoded list.
     */
    static async filterOptions(): Promise<{
        outcomeReasons: Array<{ code: string; label: string; count: number }>;
        cancelledByRoles: Array<{ role: string; count: number }>;
    }> {
        const repo = AppDataSource.getRepository(Ride);
        const [outcomes, roles] = await Promise.all([
            repo
                .createQueryBuilder('r')
                .select('r."outcomeReason"', 'code')
                .addSelect('COUNT(*)', 'count')
                .where(`r.status IN ('failed','canceled','completed')`)
                .groupBy('r."outcomeReason"')
                .orderBy('COUNT(*)', 'DESC')
                .getRawMany(),
            repo
                .createQueryBuilder('r')
                .select('r."cancelledByRole"', 'role')
                .addSelect('COUNT(*)', 'count')
                .where('r."cancelledByRole" IS NOT NULL')
                .groupBy('r."cancelledByRole"')
                .orderBy('COUNT(*)', 'DESC')
                .getRawMany(),
        ]);

        return {
            outcomeReasons: outcomes.map((o) => ({
                // NULL is a real, meaningful bucket here — the legacy rides.
                code: o.code ?? RideOutcomeCode.LEGACY_UNAVAILABLE,
                label: outcomeLabel(o.code),
                count: Number(o.count),
            })),
            cancelledByRoles: roles.map((r) => ({ role: r.role, count: Number(r.count) })),
        };
    }
}
