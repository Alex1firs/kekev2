/**
 * Recording the ride requests we could not serve.
 *
 * Written in EVERY enforcement mode, including `off`, and that is the point:
 * the rows accumulate from the moment the architecture ships, long before
 * anything is refused. When the decision to enforce is finally taken it is
 * taken against a real count of who it will turn away, rather than a guess.
 *
 * Never throws. A failure to record demand intelligence must not cost a
 * passenger their ride.
 */
import { AppDataSource } from '../config/data_source';
import { ServiceAreaMiss, MissResolution } from '../models/ServiceAreaMiss';
import { ZoneResolution } from './service_zone_resolver';

export class ServiceAreaMissService {
    static async record(args: {
        passengerId: string;
        lat: number;
        lng: number;
        resolution: ZoneResolution;
        enforcementAtTime: string;
        refused: boolean;
    }): Promise<void> {
        if (args.resolution.kind === 'inside') return;

        try {
            const repo = AppDataSource.getRepository(ServiceAreaMiss);
            await repo.save(repo.create({
                passengerId: args.passengerId,
                lat: args.lat,
                lng: args.lng,
                nearestZoneCode: args.resolution.kind === 'outside'
                    ? args.resolution.nearestZoneCode : null,
                distanceMeters: args.resolution.kind === 'outside'
                    ? args.resolution.distanceM : null,
                resolution: args.resolution.kind === 'outside'
                    ? MissResolution.OUTSIDE : MissResolution.ERROR,
                enforcementAtTime: args.enforcementAtTime,
                refused: args.refused,
            }));
        } catch (err: any) {
            console.warn(JSON.stringify({
                level: 'warn', scope: 'service_zone', event: 'miss_record_failed',
                error: err?.message ?? 'unknown',
            }));
        }
    }

    /**
     * Where the demand we cannot serve actually is.
     *
     * Rounded to ~1 km cells so the report reads as places rather than as a
     * list of coordinates — "eleven requests around here" is actionable, a
     * scatter of 7-decimal pairs is not.
     */
    static async demandClusters(sinceDays = 90): Promise<Array<{
        lat: number; lng: number; requests: number;
        nearestZoneCode: string | null; refused: number;
    }>> {
        const rows = await AppDataSource.query(
            `SELECT round(lat::numeric, 2) AS lat,
                    round(lng::numeric, 2) AS lng,
                    count(*)::int          AS requests,
                    count(*) FILTER (WHERE refused)::int AS refused,
                    mode() WITHIN GROUP (ORDER BY "nearestZoneCode") AS "nearestZoneCode"
               FROM service_area_miss
              WHERE "createdAt" > now() - ($1 || ' days')::interval
                AND resolution = $2
              GROUP BY 1, 2
              ORDER BY 3 DESC
              LIMIT 200`,
            [String(sinceDays), MissResolution.OUTSIDE],
        );
        return rows.map((r: any) => ({
            lat: Number(r.lat), lng: Number(r.lng),
            requests: r.requests, refused: r.refused,
            nearestZoneCode: r.nearestZoneCode ?? null,
        }));
    }
}
