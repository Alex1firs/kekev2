/**
 * Turning a description of an audience into the people it means.
 *
 * ── Resolved fresh, every time ───────────────────────────────────────────
 * This never returns a stored list. A saved segment holds a definition, and the
 * definition is run again at preview and again at send — because a passenger
 * who unsubscribes on Tuesday must not receive Wednesday's campaign that was
 * built on Monday.
 *
 * ── Exclusions are counted, not silently dropped ─────────────────────────
 * Every passenger removed by consent, suppression or a missing address is
 * returned with the reason. An audience that says "1,200 recipients" while
 * quietly discarding 400 is how somebody concludes the system is broken; an
 * audience that says "800 recipients, 400 excluded: 380 never opted in, 20
 * suppressed" is one they can act on.
 */

import { AppDataSource } from '../config/data_source';
import { User, UserRole } from '../models/User';
import { Ride } from '../models/Ride';
import { PassengerCommunicationPreference } from '../models/PassengerCommunicationPreference';
import { EmailSuppression } from '../models/EmailSuppression';
import { loadCommunicationsConfig } from '../config/communications_config';
import { MarketingCategory } from './marketing_consent_service';
import { AudienceType, assertAudienceAvailable } from './audience_registry';

/*
 * Who a campaign is addressed to.
 *
 * The definitions live in audience_registry.ts — one entry per audience,
 * naming its consent model, its channels and what is still missing before it
 * can be enabled. Re-exported here so existing importers are unaffected.
 */
export type { AudienceType } from './audience_registry';
export { REGISTERED_AUDIENCES, AUDIENCE_REGISTRY, audienceOptions } from './audience_registry';

export interface AudienceDefinition {
    /**
     * Who is being addressed. Defaults to passengers, which is what every
     * existing campaign means and what every stored definition omits.
     */
    audienceType?: AudienceType;

    /** Which marketing category this campaign belongs to. Gates consent. */
    category?: MarketingCategory;

    /** Ride-history shape. */
    activity?: 'all' | 'never_requested' | 'requested_never_completed' | 'completed_any' | 'frequent' | 'inactive';

    /** Overrides the configured default for `inactive`. */
    inactiveDays?: number;
    /** Overrides the configured default for `frequent`. */
    minCompletedRides?: number;
    /** Total completed-ride spend, in naira. */
    minTotalSpend?: number;

    registeredFrom?: string;
    registeredTo?: string;
    completedFrom?: string;
    completedTo?: string;

    /** Matched against pickup/destination text. Unreliable — see resolve(). */
    areas?: string[];
}

export interface AudienceMember {
    userId: string;
    email: string;
    firstName: string | null;
}

export interface AudiencePreview {
    /** Everyone the filters matched, before eligibility was applied. */
    matched: number;
    /** Who will actually be sent to. */
    eligible: number;
    excluded: number;
    exclusions: Record<string, number>;
    /** A handful of masked addresses, so an operator can sanity-check. */
    sample: Array<{ firstName: string; emailMasked: string }>;
    /** The thresholds that produced these numbers, for display beside them. */
    thresholdsApplied: Record<string, number | string>;
}

/** `a***z@example.com` — enough to recognise, not enough to harvest. */
export function maskEmail(email: string): string {
    const [local, domain] = String(email).split('@');
    if (!domain) return '***';
    const head = local.slice(0, 1);
    const tail = local.length > 1 ? local.slice(-1) : '';
    return `${head}${'*'.repeat(Math.max(1, local.length - 2))}${tail}@${domain}`;
}

export class AudienceService {
    /**
     * Resolve a definition to eligible recipients, with the reasons for every
     * exclusion.
     */
    static async resolve(definition: AudienceDefinition): Promise<{
        members: AudienceMember[];
        preview: AudiencePreview;
        /*
         * Everyone the filters matched, before consent and suppression were
         * applied. Additive; existing callers ignore it. Audience insights
         * describes THIS set rather than `members`, because "who is this
         * campaign for" and "who will receive it" are different questions, and
         * the gap between them is the thing worth noticing.
         */
        matchedIds: string[];
    }> {
        const cfg = loadCommunicationsConfig();
        const category: MarketingCategory = definition.category ?? 'promotionalOffers';

        const inactiveDays = definition.inactiveDays ?? cfg.inactiveDaysThreshold;
        const frequentThreshold = definition.minCompletedRides ?? cfg.frequentRideThreshold;

        /*
         * The audience seam. An unregistered audience stops here rather than
         * falling back to passengers — a campaign written for drivers must not
         * silently go to every passenger instead.
         */
        const audienceType: AudienceType = definition.audienceType ?? 'passenger';
        assertAudienceAvailable(audienceType);

        // ── 1. Passengers matching the activity and date filters ────────
        const qb = AppDataSource.getRepository(User).createQueryBuilder('u')
            .where('u.role = :role', { role: UserRole.PASSENGER });

        if (definition.registeredFrom) {
            qb.andWhere('u."createdAt" >= :rf', { rf: new Date(definition.registeredFrom) });
        }
        if (definition.registeredTo) {
            qb.andWhere('u."createdAt" <= :rt', { rt: new Date(definition.registeredTo) });
        }

        const activity = definition.activity ?? 'all';
        const rideTable = AppDataSource.getRepository(Ride).metadata.tableName;

        /*
         * Ride predicates are expressed as EXISTS / NOT EXISTS sub-queries
         * rather than joins, so a passenger with two hundred rides is still one
         * row and the counts cannot be silently multiplied.
         */
        const completedWindow = (alias: string) => {
            const clauses = [`${alias}."passengerId" = u.id::text`, `${alias}.status = 'completed'`];
            if (definition.completedFrom) clauses.push(`${alias}."completedAt" >= :cf`);
            if (definition.completedTo) clauses.push(`${alias}."completedAt" <= :ct`);
            return clauses.join(' AND ');
        };
        if (definition.completedFrom) qb.setParameter('cf', new Date(definition.completedFrom));
        if (definition.completedTo) qb.setParameter('ct', new Date(definition.completedTo));

        switch (activity) {
            case 'never_requested':
                qb.andWhere(`NOT EXISTS (SELECT 1 FROM "${rideTable}" r WHERE r."passengerId" = u.id::text)`);
                break;
            case 'requested_never_completed':
                qb.andWhere(`EXISTS (SELECT 1 FROM "${rideTable}" r WHERE r."passengerId" = u.id::text)`)
                  .andWhere(`NOT EXISTS (SELECT 1 FROM "${rideTable}" r2 WHERE r2."passengerId" = u.id::text AND r2.status = 'completed')`);
                break;
            case 'completed_any':
                qb.andWhere(`EXISTS (SELECT 1 FROM "${rideTable}" r WHERE ${completedWindow('r')})`);
                break;
            case 'frequent':
                qb.andWhere(
                    `(SELECT COUNT(*) FROM "${rideTable}" r WHERE ${completedWindow('r')}) >= :freq`,
                    { freq: frequentThreshold },
                );
                break;
            case 'inactive':
                /*
                 * Inactive means: has completed a ride at some point, and none
                 * of them recently. A passenger who never completed one is not
                 * "inactive" — they are a different audience with a different
                 * message, and conflating them sends a "we miss you" to
                 * somebody who never arrived.
                 */
                qb.andWhere(`EXISTS (SELECT 1 FROM "${rideTable}" r WHERE r."passengerId" = u.id::text AND r.status = 'completed')`)
                  .andWhere(`NOT EXISTS (
                        SELECT 1 FROM "${rideTable}" r3
                        WHERE r3."passengerId" = u.id::text AND r3.status = 'completed'
                          AND r3."completedAt" >= :since)`,
                      { since: new Date(Date.now() - inactiveDays * 86_400_000) });
                break;
            default:
                break;
        }

        if (definition.minCompletedRides != null && activity !== 'frequent') {
            qb.andWhere(
                `(SELECT COUNT(*) FROM "${rideTable}" r WHERE ${completedWindow('r')}) >= :minRides`,
                { minRides: definition.minCompletedRides },
            );
        }

        if (definition.minTotalSpend != null) {
            // COALESCE(finalFare, fare): the settled amount where one exists,
            // the quoted one otherwise. Summing both would double-count.
            qb.andWhere(
                `(SELECT COALESCE(SUM(COALESCE(r."finalFare", r.fare)), 0)
                    FROM "${rideTable}" r WHERE ${completedWindow('r')}) >= :spend`,
                { spend: definition.minTotalSpend },
            );
        }

        if (definition.areas?.length) {
            /*
             * Matched against pickup and destination TEXT, because there is no
             * city column on a ride. This is genuinely approximate and is
             * labelled as such in the admin UI rather than presented as a
             * geographic filter it is not.
             */
            qb.andWhere(`EXISTS (
                SELECT 1 FROM "${rideTable}" r
                WHERE r."passengerId" = u.id::text
                  AND (${definition.areas.map((_, i) => `r."pickupAddress" ILIKE :area${i} OR r."destinationAddress" ILIKE :area${i}`).join(' OR ')})
            )`);
            definition.areas.forEach((a, i) => qb.setParameter(`area${i}`, `%${a}%`));
        }

        const matched = await qb.getMany();
        const matchedIds = matched.map((u) => String(u.id));

        // ── 2. Eligibility, applied to the matched set ──────────────────
        const prefs = await AppDataSource.getRepository(PassengerCommunicationPreference).find();
        const prefByUser = new Map(prefs.map((p) => [p.userId, p]));

        const suppressedRows = await AppDataSource.getRepository(EmailSuppression).find({ select: ['email'] });
        const suppressed = new Set(suppressedRows.map((r) => r.email.toLowerCase()));

        const members: AudienceMember[] = [];
        const exclusions: Record<string, number> = {};
        const note = (reason: string) => { exclusions[reason] = (exclusions[reason] ?? 0) + 1; };

        for (const u of matched) {
            const email = String(u.email ?? '').trim().toLowerCase();
            if (!email || !email.includes('@')) { note('no_email'); continue; }
            if (suppressed.has(email)) { note('suppressed'); continue; }

            const pref = prefByUser.get(u.id);
            if (!pref) { note('never_opted_in'); continue; }

            if (category === 'safetyAnnouncements') {
                if (!pref.safetyAnnouncements) { note('category_off'); continue; }
            } else {
                if (!pref.marketing) {
                    note(pref.unsubscribedAt ? 'unsubscribed' : 'never_opted_in');
                    continue;
                }
                if (!pref[category]) { note('category_off'); continue; }
            }

            members.push({ userId: u.id, email, firstName: u.firstName ?? null });
        }

        return {
            members,
            matchedIds,
            preview: {
                matched: matched.length,
                eligible: members.length,
                excluded: matched.length - members.length,
                exclusions,
                sample: members.slice(0, 5).map((m) => ({
                    firstName: m.firstName || 'there',
                    emailMasked: maskEmail(m.email),
                })),
                thresholdsApplied: {
                    category,
                    activity,
                    frequentRideThreshold: frequentThreshold,
                    inactiveDaysThreshold: inactiveDays,
                    ...(definition.minTotalSpend != null ? { minTotalSpend: definition.minTotalSpend } : {}),
                },
            },
        };
    }

    /** Count only, for the preview panel. */
    static async preview(definition: AudienceDefinition): Promise<AudiencePreview> {
        return (await this.resolve(definition)).preview;
    }

    /**
     * How many of a matched audience are actually reachable, per channel.
     *
     * ── Why this is not one number ──────────────────────────────────────
     * "130 passengers" is true and useless: it is the size of the audience,
     * not the number of people who may lawfully and technically be sent a
     * promotion. Showing it alone invites an operator to believe a campaign
     * will reach 130 people when it will reach one. Every line below is a
     * different reason the gap exists, and each needs a different fix — a
     * suppressed address is a deliverability problem, missing consent is a
     * product problem, and no device token is an install problem.
     */
    static async channelBreakdown(userIds: string[]): Promise<{
        total: number;
        eligibleEmail: number;
        eligiblePush: number;
        eligibleSms: number;
        suppressed: number;
        noConsent: number;
        noReachableChannel: number;
    }> {
        const total = userIds.length;
        const empty = {
            total, eligibleEmail: 0, eligiblePush: 0, eligibleSms: 0,
            suppressed: 0, noConsent: 0, noReachableChannel: total,
        };
        if (total === 0) return { ...empty, noReachableChannel: 0 };

        const [row] = await AppDataSource.query(
            `WITH aud AS (SELECT unnest($1::text[]) AS id),
                  j AS (
                    SELECT a.id,
                           u.email,
                           -- COALESCE, not the raw column. A passenger with no
                           -- preference row at all yields NULL, and NULL
                           -- propagates through the NOT(...) below so they
                           -- silently vanish from the unreachable count — the
                           -- exact people the count exists to show.
                           COALESCE(p."marketing", false)      AS master,
                           COALESCE(p."marketingEmail", false) AS m_email,
                           COALESCE(p."marketingPush", false)  AS m_push,
                           COALESCE(p."marketingSms", false)   AS m_sms,
                           (s.email IS NOT NULL) AS suppressed,
                           EXISTS (SELECT 1 FROM device_token d
                                    WHERE d."userId"::text = a.id
                                      AND COALESCE(d."isActive", true)) AS has_token
                      FROM aud a
                      -- Every join is cast to text explicitly: user.id is a
                      -- uuid column while the other tables key on varchar, and
                      -- an un-cast comparison is a hard error, not a coercion.
                      JOIN "user" u ON u.id::text = a.id
                      LEFT JOIN passenger_communication_preference p ON p."userId"::text = a.id
                      LEFT JOIN email_suppression s ON lower(s.email) = lower(u.email)
                  )
             SELECT
               COUNT(*) FILTER (
                 WHERE master AND m_email AND NOT suppressed
                   AND email IS NOT NULL AND email <> '')::int          AS "eligibleEmail",
               COUNT(*) FILTER (WHERE master AND m_push AND has_token)::int AS "eligiblePush",
               COUNT(*) FILTER (WHERE master AND m_sms)::int                AS "eligibleSms",
               COUNT(*) FILTER (WHERE suppressed)::int                      AS "suppressed",
               COUNT(*) FILTER (WHERE master IS NOT TRUE)::int              AS "noConsent",
               COUNT(*) FILTER (
                 WHERE NOT (master AND m_email AND NOT suppressed AND email IS NOT NULL AND email <> '')
                   AND NOT (master AND m_push AND has_token)
                   AND NOT (master AND m_sms))::int                         AS "noReachableChannel"
               FROM j`,
            [userIds],
        );

        return {
            total,
            eligibleEmail: Number(row?.eligibleEmail ?? 0),
            eligiblePush: Number(row?.eligiblePush ?? 0),
            eligibleSms: Number(row?.eligibleSms ?? 0),
            suppressed: Number(row?.suppressed ?? 0),
            noConsent: Number(row?.noConsent ?? 0),
            noReachableChannel: Number(row?.noReachableChannel ?? 0),
        };
    }
}
