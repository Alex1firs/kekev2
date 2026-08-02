/**
 * One park, in enough detail to run it: who is on the map, who can work, what
 * is queued, and what needs attention.
 *
 * Read-only. Positions are read from the same Redis geo set dispatch reads, so
 * the map shows what the engine sees rather than a second, slightly different
 * truth maintained for display.
 */

import { In } from 'typeorm';
import { AppDataSource } from '../config/data_source';
import { Park } from '../models/Park';
import { Ride } from '../models/Ride';
import { DriverPresence, DriverPresenceState } from '../models/DriverPresence';
import { ParkRosterService } from './park_roster_service';
import { ParkOperationsCentreService, ParkOpsRow } from './park_operations_centre_service';
import { ParkDispatchService } from './park_dispatch_service';
import { ParkService } from './park_service';
import { redis } from '../config/redis';

/** The geo set dispatch maintains. Read, never written, from here. */
const DRIVER_GEO_KEY = 'drivers:locations';

export interface MapDriver {
    driverId: string;
    name: string;
    unitNumber: string | null;
    vehiclePlate: string | null;

    lat: number | null;
    lng: number | null;
    /** Metres from the park centre, when a position is known. */
    distanceM: number | null;

    presenceState: string | null;
    lastHeartbeatAt: string | null;
    /** True when the phone has stopped reporting recently enough to distrust. */
    gpsStale: boolean;

    deviceCapability: string;
    badgeSerial: string | null;
    badgeStatus: string | null;

    assignable: boolean;
    problems: Array<{ code: string; message: string }>;
}

export interface ParkDetailOps {
    park: {
        parkId: string;
        name: string;
        code: string;
        lat: number;
        lng: number;
        serviceRadiusKm: number;
        operatingRadiusM: number;
        status: string;
        opensAt: string | null;
        closesAt: string | null;
    };
    zones: Array<{ zoneId: string; name: string; kind: string; lat: number; lng: number; radiusM: number; active: boolean }>;

    /** The operations-centre row, so header numbers match the network view. */
    summary: ParkOpsRow;

    drivers: MapDriver[];
    queue: Awaited<ReturnType<typeof ParkDispatchService.queueForPark>>;

    completedRidesToday: number;
    avgWaitSeconds: number | null;
    avgPickupSeconds: number | null;
}

const GPS_STALE_MS = 3 * 60_000;

function startOfToday(): Date {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
}

export class ParkDetailOpsService {
    static async build(parkId: string): Promise<ParkDetailOps | null> {
        const park = await AppDataSource.getRepository(Park).findOneBy({ parkId });
        if (!park) return null;

        const [summary, roster, zones, queue, rideStats] = await Promise.all([
            this.summaryFor(parkId),
            ParkRosterService.view(parkId),
            ParkService.listZones(parkId, false),
            ParkDispatchService.queueForPark(parkId),
            this.rideStats(parkId),
        ]);
        if (!summary) return null;

        const drivers = await this.mapDrivers(park, roster);

        return {
            park: {
                parkId: park.parkId,
                name: park.name,
                code: park.code,
                lat: Number(park.lat),
                lng: Number(park.lng),
                serviceRadiusKm: Number(park.serviceRadiusKm),
                operatingRadiusM: Number(park.operatingRadiusM) || 250,
                status: park.status,
                opensAt: park.opensAt ?? null,
                closesAt: park.closesAt ?? null,
            },
            zones: zones.map((z: any) => ({
                zoneId: z.zoneId,
                name: z.name,
                kind: z.kind,
                lat: Number(z.lat),
                lng: Number(z.lng),
                radiusM: Number(z.radiusM),
                active: z.active !== false,
            })),
            summary,
            drivers,
            queue,
            completedRidesToday: rideStats.completed,
            avgWaitSeconds: rideStats.avgWaitSeconds,
            avgPickupSeconds: rideStats.avgPickupSeconds,
        };
    }

    /** This park's row from the network view, so the two cannot disagree. */
    private static async summaryFor(parkId: string): Promise<ParkOpsRow | null> {
        const centre = await ParkOperationsCentreService.build();
        return centre.parks.find((p) => p.parkId === parkId) ?? null;
    }

    /**
     * The roster, placed on the map.
     *
     * Positions come from the dispatch geo set in one call. A driver with no
     * entry is not an error — they have simply never reported, or their entry
     * has been evicted — and is returned with a null position rather than
     * omitted, because "rostered and invisible" is exactly what an operator
     * needs to see.
     */
    private static async mapDrivers(park: Park, roster: any[]): Promise<MapDriver[]> {
        if (roster.length === 0) return [];

        const driverIds = roster.map((r) => r.driverId);

        let positions: Array<[string, string] | null> = [];
        try {
            positions = await redis.geopos(DRIVER_GEO_KEY, ...driverIds) as any;
        } catch {
            // Redis unavailable: the rest of the page is still worth showing.
            positions = driverIds.map(() => null);
        }

        const presences = await AppDataSource.getRepository(DriverPresence).find({
            where: { driverId: In(driverIds) },
        });
        const presenceBy = new Map(presences.map((p) => [p.driverId, p]));

        const cutoff = Date.now() - GPS_STALE_MS;

        return roster.map((entry, i) => {
            const pos = positions[i];
            const lng = pos ? Number(pos[0]) : null;
            const lat = pos ? Number(pos[1]) : null;
            const presence = presenceBy.get(entry.driverId) ?? null;
            const beat = presence?.lastHeartbeatAt ? new Date(presence.lastHeartbeatAt) : null;

            const problems = ParkRosterService.assignabilityProblems(entry);

            return {
                driverId: entry.driverId,
                name: `${entry.firstName} ${entry.lastName}`.trim(),
                unitNumber: entry.unitNumber ?? null,
                vehiclePlate: entry.vehiclePlate ?? null,

                lat,
                lng,
                distanceM: lat != null && lng != null
                    ? Math.round(haversine({ lat: Number(park.lat), lng: Number(park.lng) }, { lat, lng }))
                    : null,

                presenceState: presence?.state ?? null,
                lastHeartbeatAt: beat ? beat.toISOString() : null,
                // Only meaningful for a driver who should be reporting at all.
                gpsStale: presence != null
                    && presence.state !== DriverPresenceState.OFFLINE
                    && (!beat || beat.getTime() < cutoff),

                deviceCapability: entry.deviceCapability,
                badgeSerial: entry.badgeSerial ?? null,
                badgeStatus: entry.badgeStatus ?? null,

                assignable: problems.length === 0,
                problems,
            };
        });
    }

    /**
     * Today's completions, and the two waits a passenger actually feels.
     *
     * Wait is request → driver accepted. Pickup is accepted → passenger picked
     * up. They are separate because they have separate causes: the first is a
     * dispatch problem, the second is a driver or traffic problem, and
     * averaging them together hides which one is happening.
     */
    private static async rideStats(parkId: string) {
        const rows = await AppDataSource.getRepository(Ride)
            .createQueryBuilder('r')
            .select('COUNT(*) FILTER (WHERE r.status = :completed)', 'completed')
            .addSelect(
                'AVG(EXTRACT(EPOCH FROM (r."acceptedAt" - r."createdAt"))) '
                + 'FILTER (WHERE r."acceptedAt" IS NOT NULL)', 'avgWait')
            .addSelect(
                'AVG(EXTRACT(EPOCH FROM (r."startedAt" - r."acceptedAt"))) '
                + 'FILTER (WHERE r."startedAt" IS NOT NULL AND r."acceptedAt" IS NOT NULL)', 'avgPickup')
            .where('r."parkId" = :parkId', { parkId })
            .andWhere('r."createdAt" >= :since', { since: startOfToday() })
            .setParameter('completed', 'completed')
            .getRawOne<{ completed: string; avgWait: string | null; avgPickup: string | null }>();

        return {
            completed: Number(rows?.completed ?? 0),
            avgWaitSeconds: rows?.avgWait != null ? Math.round(Number(rows.avgWait)) : null,
            avgPickupSeconds: rows?.avgPickup != null ? Math.round(Number(rows.avgPickup)) : null,
        };
    }
}

function haversine(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
    const R = 6371000;
    const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const s = Math.sin(dLat / 2) ** 2
        + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
}
