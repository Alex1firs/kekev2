/**
 * Who a campaign is actually about to reach.
 *
 * ── The point of this screen ─────────────────────────────────────────────
 * A count is not an audience. "12,400 passengers" reads the same whether they
 * are the platform's best riders or twelve thousand people who signed up once
 * and never booked. This turns the number into a description, so somebody can
 * notice they are about to send a loyalty offer to people who have never
 * completed a ride.
 *
 * ── It describes the matched set, before eligibility ─────────────────────
 * Deliberately. Consent and suppression are applied later and reported
 * separately; mixing them here would answer "who will receive this" when the
 * question being asked is "who is this for". Both matter, and confusing them
 * hides the case worth catching — a well-chosen audience that almost nobody has
 * consented to reach.
 *
 * ── One query, many aggregates ───────────────────────────────────────────
 * Every breakdown below is computed in a single pass over the matched user ids
 * rather than as a dozen COUNT queries. On a table this size either would work;
 * the shape matters when it is not.
 *
 * ── Nothing here returns an address or a phone number ────────────────────
 * Counts and averages only. There is no code path in this file that can emit a
 * passenger's contact details, which is what makes it safe to put on a screen
 * several roles can open.
 */

import { AppDataSource } from '../config/data_source';
import { AudienceService, AudienceDefinition } from './audience_service';
import { audienceEntry, AudienceType } from './audience_registry';

/** Completed rides at or above this in the window: a high-frequency rider. */
const HIGH_FREQUENCY_RIDES = 8;

/** No completed ride in this many days: dormant. */
const DORMANT_DAYS = 60;

/** Registered within this many days: new. */
const NEW_DAYS = 30;

export interface AudienceInsights {
    total: number;
    lifecycle: {
        active: number;
        inactive: number;
        newPassengers: number;
        returning: number;
        highFrequency: number;
        dormant: number;
        neverCompletedRide: number;
    };
    behaviour: {
        averageRides: number;
        medianRides: number;
        averageSpendNaira: number;
        totalSpendNaira: number;
    };
    cities: Array<{ name: string; count: number }>;
    parks: Array<{ name: string; count: number }>;
    devices: {
        android: number;
        ios: number;
        noDevice: number;
        /** Of those with any device registered. */
        androidSharePct: number | null;
    };
    definitions: Record<string, string>;
}

export class AudienceInsightsService {
    /**
     * Describe the audience a definition selects.
     *
     * Resolved fresh every time. A cached audience is a lie the moment somebody
     * registers, completes a ride or unsubscribes, and this is read immediately
     * before an approval decision.
     */
    static async describe(definition: AudienceDefinition): Promise<AudienceInsights> {
        const audienceType: AudienceType = (definition.audienceType ?? 'passenger') as AudienceType;
        const entry = audienceEntry(audienceType);
        if (!entry.enabled) {
            throw new Error(`The "${entry.label}" audience cannot be described yet: it has no members to describe.`);
        }

        const resolved = await AudienceService.resolve(definition);
        const userIds = resolved.matchedIds;

        if (userIds.length === 0) return this.empty();

        const [lifecycle, behaviour, cities, parks, devices] = await Promise.all([
            this.lifecycle(userIds),
            this.behaviour(userIds),
            this.cities(userIds),
            this.parks(userIds),
            this.devices(userIds),
        ]);

        return {
            total: userIds.length,
            lifecycle,
            behaviour,
            cities,
            parks,
            devices,
            definitions: this.definitions(),
        };
    }

    /**
     * The thresholds, in words, returned with the numbers.
     *
     * "Dormant: 412" means nothing without "no completed ride in 60 days", and
     * an operator who has to go and find the threshold in a config file will
     * instead assume one — usually a different one from the code's.
     */
    private static definitions(): Record<string, string> {
        return {
            active: 'Completed at least one ride in the last 30 days.',
            inactive: 'Has completed a ride, but none in the last 30 days.',
            new: `Registered in the last ${NEW_DAYS} days.`,
            returning: 'Completed two or more rides in total.',
            highFrequency: `Completed ${HIGH_FREQUENCY_RIDES} or more rides in total.`,
            dormant: `No completed ride in ${DORMANT_DAYS} days, but has completed one before.`,
            neverCompletedRide: 'Registered, never completed a ride. Includes people who only ever cancelled.',
            averageSpend: 'Mean of total completed-ride fares per passenger, in naira. Excludes cancelled rides.',
            cities: 'From the park a ride was dispatched through, not from the passenger\'s address — KekeRide does not hold addresses.',
            devices: 'From registered push tokens. A passenger with no token has the app uninstalled or push denied.',
        };
    }

    private static async lifecycle(userIds: string[]) {
        const [row] = await AppDataSource.query(
            `
            WITH ids AS (SELECT unnest($1::text[]) AS id),
            r AS (
                SELECT "passengerId" AS id,
                       COUNT(*) FILTER (WHERE status = 'completed')                       AS completed,
                       MAX("completedAt") FILTER (WHERE status = 'completed')             AS last_ride
                FROM ride
                WHERE "passengerId" IN (SELECT id FROM ids)
                GROUP BY 1
            )
            SELECT
                COUNT(*) FILTER (WHERE r.last_ride >= now() - INTERVAL '30 days')                        AS active,
                COUNT(*) FILTER (WHERE r.completed > 0 AND (r.last_ride IS NULL OR r.last_ride < now() - INTERVAL '30 days')) AS inactive,
                COUNT(*) FILTER (WHERE u."createdAt" >= now() - ($2 || ' days')::interval)               AS new_passengers,
                COUNT(*) FILTER (WHERE r.completed >= 2)                                                 AS returning,
                COUNT(*) FILTER (WHERE r.completed >= $3)                                                AS high_frequency,
                COUNT(*) FILTER (WHERE r.completed > 0 AND r.last_ride < now() - ($4 || ' days')::interval) AS dormant,
                COUNT(*) FILTER (WHERE COALESCE(r.completed, 0) = 0)                                     AS never_completed
            FROM ids
            JOIN "user" u ON u.id::text = ids.id
            LEFT JOIN r ON r.id = ids.id
            `,
            [userIds, String(NEW_DAYS), HIGH_FREQUENCY_RIDES, String(DORMANT_DAYS)],
        );

        return {
            active: Number(row?.active ?? 0),
            inactive: Number(row?.inactive ?? 0),
            newPassengers: Number(row?.new_passengers ?? 0),
            returning: Number(row?.returning ?? 0),
            highFrequency: Number(row?.high_frequency ?? 0),
            dormant: Number(row?.dormant ?? 0),
            neverCompletedRide: Number(row?.never_completed ?? 0),
        };
    }

    private static async behaviour(userIds: string[]) {
        const [row] = await AppDataSource.query(
            `
            WITH ids AS (SELECT unnest($1::text[]) AS id),
            per_user AS (
                SELECT ids.id,
                       COUNT(r.id) FILTER (WHERE r.status = 'completed')                            AS rides,
                       COALESCE(SUM(COALESCE(r."finalFare", r.fare)) FILTER (WHERE r.status = 'completed'), 0) AS spend
                FROM ids
                LEFT JOIN ride r ON r."passengerId" = ids.id
                GROUP BY ids.id
            )
            SELECT
                ROUND(AVG(rides)::numeric, 2)                          AS avg_rides,
                PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY rides)     AS median_rides,
                ROUND(AVG(spend)::numeric, 2)                          AS avg_spend,
                COALESCE(SUM(spend), 0)                                AS total_spend
            FROM per_user
            `,
            [userIds],
        );

        return {
            averageRides: Number(row?.avg_rides ?? 0),
            medianRides: Number(row?.median_rides ?? 0),
            averageSpendNaira: Number(row?.avg_spend ?? 0),
            totalSpendNaira: Number(row?.total_spend ?? 0),
        };
    }

    /**
     * Cities, derived from the park a ride went through.
     *
     * KekeRide holds no passenger addresses, and the free-text pickup string is
     * whatever a geocoder returned — parsing a city out of it produces a chart
     * full of near-duplicates. The park is a real record with a real city on it,
     * so passengers who have only ever ridden outside a park are reported as
     * unknown rather than guessed at.
     */
    private static async cities(userIds: string[]) {
        const rows = await AppDataSource.query(
            `
            SELECT COALESCE(p.city, 'Unknown') AS name, COUNT(DISTINCT r."passengerId")::int AS count
            FROM ride r
            LEFT JOIN park p ON p.id = r."parkId"
            WHERE r."passengerId" = ANY($1::text[]) AND r.status = 'completed'
            GROUP BY 1 ORDER BY 2 DESC LIMIT 12
            `,
            [userIds],
        );
        return rows.map((r: any) => ({ name: r.name, count: Number(r.count) }));
    }

    private static async parks(userIds: string[]) {
        const rows = await AppDataSource.query(
            `
            SELECT p.name AS name, COUNT(DISTINCT r."passengerId")::int AS count
            FROM ride r
            JOIN park p ON p.id = r."parkId"
            WHERE r."passengerId" = ANY($1::text[]) AND r.status = 'completed'
            GROUP BY 1 ORDER BY 2 DESC LIMIT 12
            `,
            [userIds],
        );
        return rows.map((r: any) => ({ name: r.name, count: Number(r.count) }));
    }

    private static async devices(userIds: string[]) {
        const [row] = await AppDataSource.query(
            `
            WITH ids AS (SELECT unnest($1::text[]) AS id),
            t AS (
                SELECT "userId" AS id,
                       BOOL_OR(platform = 'android') AS android,
                       BOOL_OR(platform = 'ios')     AS ios
                FROM device_token
                WHERE "userId" IN (SELECT id FROM ids) AND "isActive" = true
                GROUP BY 1
            )
            SELECT
                COUNT(*) FILTER (WHERE t.android)                       AS android,
                COUNT(*) FILTER (WHERE t.ios)                           AS ios,
                COUNT(*) FILTER (WHERE t.id IS NULL)                    AS no_device
            FROM ids LEFT JOIN t ON t.id = ids.id
            `,
            [userIds],
        );

        const android = Number(row?.android ?? 0);
        const ios = Number(row?.ios ?? 0);
        const withDevice = android + ios;

        return {
            android,
            ios,
            noDevice: Number(row?.no_device ?? 0),
            androidSharePct: withDevice > 0 ? Math.round((android / withDevice) * 1000) / 10 : null,
        };
    }

    private static empty(): AudienceInsights {
        return {
            total: 0,
            lifecycle: {
                active: 0, inactive: 0, newPassengers: 0, returning: 0,
                highFrequency: 0, dormant: 0, neverCompletedRide: 0,
            },
            behaviour: { averageRides: 0, medianRides: 0, averageSpendNaira: 0, totalSpendNaira: 0 },
            cities: [], parks: [],
            devices: { android: 0, ios: 0, noDevice: 0, androidSharePct: null },
            definitions: this.definitions(),
        };
    }
}
