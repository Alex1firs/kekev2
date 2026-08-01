/**
 * Data access for park driver rosters.
 *
 * The roster view is the densest join in the system: for every member it needs
 * the driver's name, vehicle, unit number, device capability, phone, badge,
 * wallet balance and debt, last ride, live presence and queue position. Done
 * naively that is nine queries per driver.
 *
 * `loadRosterView` does it in six queries TOTAL, regardless of roster size.
 * That is the whole reason this file exists.
 */
import { In, IsNull, Not, Repository } from 'typeorm';
import { AppDataSource } from '../config/data_source';
import { ParkDriverRoster, RosterStatus } from '../models/ParkDriverRoster';
import { DriverProfile } from '../models/DriverProfile';
import { User } from '../models/User';
import { Wallet } from '../models/Wallet';
import { Ride } from '../models/Ride';
import { DriverBadge, BadgeStatus } from '../models/DriverBadge';
import { DriverPresence, DriverPresenceState } from '../models/DriverPresence';

/** One fully-populated roster line, as the dispatcher and admin screens need it. */
export interface RosterEntry {
    rosterId: string;
    driverId: string;
    status: RosterStatus;
    queuePosition: number | null;
    queuedAt: Date | null;
    joinedAt: Date;
    skipCount: number;
    suspensionReason: string | null;

    // driver
    firstName: string;
    lastName: string;
    unitNumber: string | null;
    vehiclePlate: string;
    vehicleModel: string;
    driverStatus: string;
    photoUrl: string | null;
    rating: number;
    ratingCount: number;

    /** smartphone | feature_phone | none. Never inferred. */
    deviceCapability: string;
    /** True only for a driver who can actually run the driver app. */
    smartphoneCapable: boolean;
    /** True when the driver can be reached only by voice/SMS. */
    featurePhoneOnly: boolean;
    phone: string | null;

    // badge
    badgeSerial: string | null;
    badgeStatus: BadgeStatus | null;
    badgeShortCode: string | null;

    // wallet
    walletBalance: number;
    commissionDebt: number;
    /** Debt at or above the cash-ride block threshold. */
    walletBlocked: boolean;

    // activity
    lastRideId: string | null;
    lastRideAt: Date | null;
    presenceState: DriverPresenceState | null;
    presenceSince: Date | null;
    presenceParkId: string | null;
}

export interface RosterQuery {
    parkId: string;
    status?: RosterStatus;
    /** Only drivers currently in the queue. */
    queuedOnly?: boolean;
    search?: string;
    includeRemoved?: boolean;
}

export class ParkRosterRepository {
    private static get repo(): Repository<ParkDriverRoster> {
        return AppDataSource.getRepository(ParkDriverRoster);
    }

    static findById(id: string): Promise<ParkDriverRoster | null> {
        return this.repo.findOneBy({ id });
    }

    /** The live membership row for a driver at a park, if any. */
    static findMembership(parkId: string, driverId: string): Promise<ParkDriverRoster | null> {
        return this.repo.findOne({
            where: { parkId, driverId, status: Not(RosterStatus.REMOVED) },
        });
    }

    /** Every park a driver is rostered at. */
    static findMembershipsForDriver(driverId: string): Promise<ParkDriverRoster[]> {
        return this.repo.find({
            where: { driverId, status: Not(RosterStatus.REMOVED) },
            order: { joinedAt: 'ASC' },
        });
    }

    static create(data: Partial<ParkDriverRoster>): ParkDriverRoster {
        return this.repo.create(data);
    }

    static save(row: ParkDriverRoster): Promise<ParkDriverRoster> {
        return this.repo.save(row);
    }

    static findRaw(query: RosterQuery): Promise<ParkDriverRoster[]> {
        const qb = this.repo.createQueryBuilder('r').where('r."parkId" = :parkId', { parkId: query.parkId });
        if (query.status) qb.andWhere('r.status = :status', { status: query.status });
        else if (!query.includeRemoved) qb.andWhere('r.status <> :removed', { removed: RosterStatus.REMOVED });
        if (query.queuedOnly) qb.andWhere('r."queuePosition" IS NOT NULL');
        // Queued drivers first, in queue order; then everyone else by join date.
        qb.orderBy('r."queuePosition"', 'ASC', 'NULLS LAST').addOrderBy('r."joinedAt"', 'ASC');
        return qb.getMany();
    }

    /**
     * The full roster view.
     *
     * Six queries regardless of size: memberships, profiles, users, wallets,
     * badges, presence — plus one grouped query for last rides. Everything is
     * assembled in memory afterwards.
     */
    static async loadRosterView(query: RosterQuery, cashBlockThreshold: number): Promise<RosterEntry[]> {
        const memberships = await this.findRaw(query);
        if (memberships.length === 0) return [];

        const driverIds = memberships.map((m) => m.driverId);

        const [profiles, users, wallets, badges, presence, lastRides] = await Promise.all([
            AppDataSource.getRepository(DriverProfile).find({ where: { userId: In(driverIds) } }),
            AppDataSource.getRepository(User).find({ where: { id: In(driverIds) } }),
            AppDataSource.getRepository(Wallet).find({ where: { userId: In(driverIds) } }),
            AppDataSource.getRepository(DriverBadge).find({
                where: { driverId: In(driverIds), status: In([BadgeStatus.ACTIVE, BadgeStatus.PENDING_ACTIVATION]) },
            }),
            AppDataSource.getRepository(DriverPresence).find({ where: { driverId: In(driverIds) } }),
            // Most recent completed-or-active ride per driver, in one pass.
            AppDataSource.getRepository(Ride).createQueryBuilder('ride')
                .select('DISTINCT ON (ride."driverId") ride."driverId"', 'driverId')
                .addSelect('ride."rideId"', 'rideId')
                .addSelect('ride."createdAt"', 'createdAt')
                .where('ride."driverId" IN (:...driverIds)', { driverIds })
                .orderBy('ride."driverId"', 'ASC')
                .addOrderBy('ride."createdAt"', 'DESC')
                .getRawMany<{ driverId: string; rideId: string; createdAt: Date }>(),
        ]);

        const profileBy = new Map(profiles.map((p) => [p.userId, p]));
        const userBy = new Map(users.map((u) => [u.id, u]));
        const walletBy = new Map(wallets.map((w) => [w.userId, w]));
        const badgeBy = new Map(badges.map((b) => [b.driverId, b]));
        const presenceBy = new Map(presence.map((p) => [p.driverId, p]));
        const lastRideBy = new Map(lastRides.map((r) => [r.driverId, r]));

        const entries: RosterEntry[] = memberships.map((m) => {
            const profile = profileBy.get(m.driverId);
            const user = userBy.get(m.driverId);
            const wallet = walletBy.get(m.driverId);
            const badge = badgeBy.get(m.driverId);
            const p = presenceBy.get(m.driverId);
            const lastRide = lastRideBy.get(m.driverId);

            const capability = profile?.deviceCapability ?? 'smartphone';
            const ratingCount = profile?.ratingCount ?? 0;
            const debt = wallet ? Number(wallet.driverCommissionDebt) : 0;

            return {
                rosterId: m.id,
                driverId: m.driverId,
                status: m.status,
                queuePosition: m.queuePosition,
                queuedAt: m.queuedAt,
                joinedAt: m.joinedAt,
                skipCount: m.skipCount,
                suspensionReason: m.suspensionReason,

                firstName: profile?.firstName ?? user?.firstName ?? 'Unknown',
                lastName: profile?.lastName ?? user?.lastName ?? '',
                unitNumber: profile?.unitNumber ?? null,
                vehiclePlate: profile?.vehiclePlate ?? '—',
                vehicleModel: profile?.vehicleModel ?? '—',
                driverStatus: profile?.status ?? 'unknown',
                photoUrl: profile?.photoUrl ?? null,
                rating: ratingCount > 0 ? Number(((profile?.ratingSum ?? 0) / ratingCount).toFixed(2)) : 0,
                ratingCount,

                deviceCapability: capability,
                smartphoneCapable: capability === 'smartphone',
                featurePhoneOnly: capability === 'feature_phone' || capability === 'none',
                phone: user?.phone ?? null,

                badgeSerial: badge?.badgeSerial ?? null,
                badgeStatus: badge?.status ?? null,
                badgeShortCode: badge?.shortCode ?? null,

                walletBalance: wallet ? Number(wallet.driverAvailableBalance) : 0,
                commissionDebt: debt,
                walletBlocked: debt >= cashBlockThreshold,

                lastRideId: lastRide?.rideId ?? null,
                lastRideAt: lastRide?.createdAt ?? null,
                presenceState: p?.state ?? null,
                presenceSince: p?.since ?? null,
                presenceParkId: p?.parkId ?? null,
            };
        });

        if (!query.search?.trim()) return entries;

        // Searching in memory: a roster is tens of rows, and pushing the term
        // into SQL would mean joining four tables just to filter them.
        const term = query.search.trim().toLowerCase();
        return entries.filter((e) =>
            `${e.firstName} ${e.lastName}`.toLowerCase().includes(term)
            || (e.unitNumber ?? '').toLowerCase().includes(term)
            || e.vehiclePlate.toLowerCase().includes(term)
            || (e.phone ?? '').includes(term)
            || (e.badgeSerial ?? '').toLowerCase().includes(term));
    }

    // ── queue ───────────────────────────────────────────────────────────

    /** Everyone currently queued at a park, in position order. */
    static findQueue(parkId: string): Promise<ParkDriverRoster[]> {
        return this.repo.find({
            where: { parkId, status: RosterStatus.ACTIVE, queuePosition: Not(IsNull()) },
            order: { queuePosition: 'ASC' },
        });
    }

    static async maxQueuePosition(parkId: string): Promise<number> {
        const row = await this.repo.createQueryBuilder('r')
            .select('COALESCE(MAX(r."queuePosition"), 0)', 'max')
            .where('r."parkId" = :parkId', { parkId })
            .andWhere('r."queuePosition" IS NOT NULL')
            .getRawOne<{ max: string }>();
        return Number(row?.max ?? 0);
    }

    /**
     * Rewrite the queue to exactly this order, in one transaction.
     *
     * Positions are set to NULL first. Without that, moving driver 3 to
     * position 1 transiently collides with the driver already there, and any
     * uniqueness we later add on (parkId, queuePosition) would reject a
     * perfectly legitimate reorder.
     */
    static async reorderQueue(parkId: string, orderedRosterIds: string[]): Promise<void> {
        await AppDataSource.transaction(async (manager) => {
            await manager.getRepository(ParkDriverRoster)
                .createQueryBuilder()
                .update()
                .set({ queuePosition: null })
                .where('"parkId" = :parkId', { parkId })
                .execute();

            for (let i = 0; i < orderedRosterIds.length; i += 1) {
                await manager.getRepository(ParkDriverRoster)
                    .createQueryBuilder()
                    .update()
                    .set({ queuePosition: i + 1 })
                    .where('id = :id AND "parkId" = :parkId', { id: orderedRosterIds[i], parkId })
                    .execute();
            }
        });
    }

    /** Close gaps after a removal so positions stay 1..n with no holes. */
    static async compactQueue(parkId: string): Promise<void> {
        const queued = await this.findQueue(parkId);
        await this.reorderQueue(parkId, queued.map((q) => q.id));
    }
}
