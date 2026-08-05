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

export interface AudienceDefinition {
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
    }> {
        const cfg = loadCommunicationsConfig();
        const category: MarketingCategory = definition.category ?? 'promotionalOffers';

        const inactiveDays = definition.inactiveDays ?? cfg.inactiveDaysThreshold;
        const frequentThreshold = definition.minCompletedRides ?? cfg.frequentRideThreshold;

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
}
