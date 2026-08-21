/**
 * Lifecycle automations: ride events become passenger communications.
 *
 * The pipeline, in order, and the order matters:
 *
 *   event → trigger lookup → ride eligibility → cohort (TEST/PILOT/PRODUCTION)
 *         → consent class → per-channel consent → cooldown / frequency cap
 *         → CLAIM the dedupe slot → render → send → record
 *
 * ── The claim is the important step ─────────────────────────────────────
 * The dispatch row is written BEFORE anything is sent, and the unique index on
 * (triggerKey, dedupeKey, channel) is what makes the claim exclusive. A second
 * completion event, a second worker, or a restart mid-send all collide with
 * that index and lose. No application-level "have we sent this already?" check
 * can offer that, because between the check and the send there is a window.
 *
 * ── The cohort is applied before work exists, not during sending ────────
 * In TEST and PILOT the allow-list is intersected in `mayReach` before a
 * dispatch row is created. There is deliberately no path that resolves the full
 * audience and filters afterwards: a downstream mistake then cannot queue 130
 * messages, because the rows were never created.
 */
import { AppDataSource } from '../config/data_source';
import { CommunicationTrigger, ConsentClass, AutomationMode } from '../models/CommunicationTrigger';
import { CommunicationDispatch, DispatchStatus } from '../models/CommunicationDispatch';
import { CommunicationTestSubject } from '../models/CommunicationTestSubject';
import { User, UserRole } from '../models/User';
import { Ride } from '../models/Ride';
import { MarketingConsentService, SuppressionService } from '../services/marketing_consent_service';
import { renderServiceTemplate, pushForTrigger, ServiceContext } from './service_templates';
import { emailProvider, senderIdentity } from './email_provider';
import { NotificationService } from './notification_service';
import { loadCommunicationsConfig } from '../config/communications_config';
import { RideCommunicationEvent } from './communication_events';
import { NotificationPriority } from './notification_priority';

/** Why a passenger was not reached. Recorded, never silently dropped. */
export type SkipReason =
    | 'automation_disabled' | 'no_trigger' | 'outcome_not_eligible'
    | 'ride_voided' | 'ride_not_found' | 'passenger_not_found'
    | 'not_in_test_cohort' | 'no_consent' | 'suppressed' | 'no_email'
    | 'no_destination' | 'channel_disabled' | 'cooldown' | 'frequency_cap'
    | 'already_sent' | 'no_template';

export interface AutomationOutcome {
    triggerKey: string;
    handled: boolean;
    channels: Array<{ channel: string; status: DispatchStatus; reason?: string }>;
    skipped?: SkipReason;
}

export class LifecycleAutomationService {
    private static get triggers() { return AppDataSource.getRepository(CommunicationTrigger); }
    private static get dispatches() { return AppDataSource.getRepository(CommunicationDispatch); }
    private static get subjects() { return AppDataSource.getRepository(CommunicationTestSubject); }

    // ── Entry point ─────────────────────────────────────────────────────

    /**
     * Handle one ride event. Never throws: the caller is the ride lifecycle.
     */
    static async handleRideEvent(event: RideCommunicationEvent): Promise<AutomationOutcome[]> {
        const outcomes: AutomationOutcome[] = [];
        try {
            const enabled = await this.triggers.find({ where: { enabled: true } });
            for (const trigger of enabled) {
                if (!Array.isArray(trigger.triggerCodes) || trigger.triggerCodes.length === 0) continue;
                if (!event.outcomeReason) continue;
                if (!trigger.triggerCodes.includes(event.outcomeReason)) continue;
                outcomes.push(await this.runTrigger(trigger, event));
            }
        } catch (err: any) {
            console.error(JSON.stringify({
                level: 'error', scope: 'lifecycle_automation',
                rideId: event.rideId, message: err?.message ?? String(err),
            }));
        }
        return outcomes;
    }

    // ── One trigger, one passenger ──────────────────────────────────────

    private static async runTrigger(
        trigger: CommunicationTrigger,
        event: RideCommunicationEvent,
    ): Promise<AutomationOutcome> {
        const out: AutomationOutcome = { triggerKey: trigger.key, handled: false, channels: [] };

        // A voided ride is a training or demo run. Nobody was really carried,
        // so nobody is thanked and nobody is apologised to.
        const ride = await AppDataSource.getRepository(Ride).findOne({ where: { rideId: event.rideId } });
        if (!ride) { out.skipped = 'ride_not_found'; return out; }
        if (ride.voided === true) { out.skipped = 'ride_voided'; return out; }

        const passenger = await AppDataSource.getRepository(User)
            .findOne({ where: { id: event.passengerId } });
        if (!passenger) { out.skipped = 'passenger_not_found'; return out; }

        const reach = await this.mayReach(trigger, passenger.id);
        if (!reach.ok) { out.skipped = reach.reason; return out; }

        const cap = await this.withinLimits(trigger, passenger.id);
        if (!cap.ok) { out.skipped = cap.reason; return out; }

        const dedupeKey = event.rideId;
        const sendAfter = new Date(Date.now() + Math.max(0, trigger.delayMinutes) * 60_000);

        for (const channel of trigger.channels) {
            const result = await this.claimAndQueue({
                trigger, channel, userId: passenger.id, dedupeKey,
                rideId: event.rideId, outcomeReason: event.outcomeReason, sendAfter,
                passengerEmail: passenger.email ?? null,
            });
            out.channels.push(result);
            if (result.status !== DispatchStatus.SKIPPED) out.handled = true;
        }

        if (out.handled) {
            await this.triggers.update(trigger.id, { lastTriggeredAt: new Date() });
        }
        return out;
    }

    // ── Cohort gate ─────────────────────────────────────────────────────

    /**
     * May this automation reach this passenger at all, given its rollout mode?
     *
     * Called before any dispatch row exists. In TEST and PILOT a passenger who
     * is not on the allow-list produces no row and therefore no work.
     */
    static async mayReach(
        trigger: CommunicationTrigger,
        userId: string,
    ): Promise<{ ok: true } | { ok: false; reason: SkipReason }> {
        if (!trigger.enabled) return { ok: false, reason: 'automation_disabled' };
        if (trigger.mode === AutomationMode.PRODUCTION) return { ok: true };

        const scope = trigger.mode === AutomationMode.PILOT ? 'PILOT' : 'TEST';
        const listed = await this.subjects.findOne({ where: { userId, scope } });
        // A PILOT run also accepts the TEST cohort: the test accounts are a
        // subset of any wider group, and excluding them would mean losing the
        // ability to verify during a pilot.
        if (!listed && scope === 'PILOT') {
            const asTest = await this.subjects.findOne({ where: { userId, scope: 'TEST' } });
            if (asTest) return { ok: true };
        }
        return listed ? { ok: true } : { ok: false, reason: 'not_in_test_cohort' };
    }

    /** The allow-listed ids for a mode. Used to intersect an audience up front. */
    static async cohortIds(mode: AutomationMode): Promise<string[] | null> {
        if (mode === AutomationMode.PRODUCTION) return null;   // null = unrestricted
        const scopes = mode === AutomationMode.PILOT ? ['PILOT', 'TEST'] : ['TEST'];
        const rows = await this.subjects.find({ where: scopes.map((scope) => ({ scope })) });
        return [...new Set(rows.map((r) => r.userId))];
    }

    // ── Cooldown and frequency cap ──────────────────────────────────────

    private static async withinLimits(
        trigger: CommunicationTrigger,
        userId: string,
    ): Promise<{ ok: true } | { ok: false; reason: SkipReason }> {
        // Cooldown: the gap since we last actually sent this automation to this
        // passenger. This is what stops five apologies from five taps.
        if (trigger.cooldownMinutes > 0) {
            const since = new Date(Date.now() - trigger.cooldownMinutes * 60_000);
            const recent = await this.dispatches
                .createQueryBuilder('d')
                .where('d."triggerKey" = :k', { k: trigger.key })
                .andWhere('d."userId" = :u', { u: userId })
                .andWhere('d.status IN (:...ok)', { ok: [DispatchStatus.SENT, DispatchStatus.QUEUED] })
                .andWhere('d."createdAt" >= :since', { since })
                .getCount();
            if (recent > 0) return { ok: false, reason: 'cooldown' };
        }

        if (trigger.frequencyCap > 0) {
            const since = new Date(Date.now() - trigger.frequencyWindowDays * 86_400_000);
            const count = await this.dispatches
                .createQueryBuilder('d')
                .where('d."triggerKey" = :k', { k: trigger.key })
                .andWhere('d."userId" = :u', { u: userId })
                .andWhere('d.status = :s', { s: DispatchStatus.SENT })
                .andWhere('d."createdAt" >= :since', { since })
                .getCount();
            if (count >= trigger.frequencyCap) return { ok: false, reason: 'frequency_cap' };
        }

        return { ok: true };
    }

    // ── Consent ─────────────────────────────────────────────────────────

    /**
     * Consent for one channel, respecting the message's class.
     *
     * A SERVICE message does not require marketing consent — it is a response
     * to something the passenger themselves did — but it still respects
     * suppression, because suppression is a fact from the mail system rather
     * than a preference, and sending to a hard-bounced address damages the
     * domain that also carries verification codes.
     */
    static async consentFor(
        consentClass: ConsentClass,
        userId: string,
        channel: string,
        destination: string | null,
    ): Promise<{ ok: true } | { ok: false; reason: SkipReason }> {
        if (consentClass === ConsentClass.SERVICE) {
            if (channel === 'email') {
                if (!destination || !destination.includes('@')) return { ok: false, reason: 'no_email' };
                if (await SuppressionService.isSuppressed(destination)) {
                    return { ok: false, reason: 'suppressed' };
                }
            }
            return { ok: true };
        }

        const result = await MarketingConsentService.checkChannelEligibility(
            userId, channel as any, 'promotionalOffers', destination,
        );
        if (result.eligible) return { ok: true };
        const reason = (result.reason ?? 'no_consent') as SkipReason;
        return { ok: false, reason };
    }

    // ── Claim, then queue ───────────────────────────────────────────────

    private static async claimAndQueue(args: {
        trigger: CommunicationTrigger;
        channel: string;
        userId: string;
        dedupeKey: string;
        rideId: string | null;
        outcomeReason: string | null;
        sendAfter: Date;
        passengerEmail: string | null;
    }): Promise<{ channel: string; status: DispatchStatus; reason?: string }> {
        const { trigger, channel, userId } = args;

        const destination = channel === 'email' ? args.passengerEmail : null;
        const consent = await this.consentFor(trigger.consentClass, userId, channel, destination);

        // A skip is recorded, not silently dropped: support needs to be able to
        // answer "why didn't they get it?" and the answer must be on the record.
        const status = consent.ok ? DispatchStatus.QUEUED : DispatchStatus.SKIPPED;
        const reason = consent.ok ? null : consent.reason;

        try {
            const row = this.dispatches.create({
                triggerKey: trigger.key,
                dedupeKey: args.dedupeKey,
                userId,
                channel,
                status,
                reason,
                rideId: args.rideId,
                outcomeReason: args.outcomeReason,
                mode: trigger.mode,
                sendAfter: consent.ok ? args.sendAfter : null,
            });
            await this.dispatches.insert(row);
            return { channel, status, reason: reason ?? undefined };
        } catch (err: any) {
            // 23505 = unique violation: somebody already claimed this slot.
            // That is the deduplication working, not a fault.
            if (err?.code === '23505') {
                return { channel, status: DispatchStatus.SKIPPED, reason: 'already_sent' };
            }
            throw err;
        }
    }

    // ── Sending ─────────────────────────────────────────────────────────

    /**
     * Send the dispatch rows that are due.
     *
     * Separate from claiming so the delay survives a restart, and so a provider
     * outage retries rather than losing the message.
     */
    static async sendDue(limit = 50): Promise<{ attempted: number; sent: number; failed: number }> {
        const out = { attempted: 0, sent: 0, failed: 0 };

        /*
         * Claim before delivering.
         *
         * Selecting QUEUED rows and then sending them lets two workers pick the
         * same row and deliver it twice — the unique index guarantees one CLAIM
         * per ride per channel, which is a different thing from one DELIVERY
         * per claim. The conditional UPDATE is the arbiter: whoever commits
         * first moves the row out of `queued`, and SKIP LOCKED means the other
         * worker takes different rows rather than blocking on these.
         */
        const claimed = await AppDataSource.query(
            `UPDATE communication_dispatch
                SET status = $1, attempts = attempts + 1
              WHERE id IN (
                    SELECT id FROM communication_dispatch
                     WHERE status = $2
                       AND "sendAfter" IS NOT NULL AND "sendAfter" <= now()
                       AND attempts < 3
                     ORDER BY "sendAfter" ASC
                     LIMIT $3
                     FOR UPDATE SKIP LOCKED
              )
              RETURNING *`,
            [DispatchStatus.SENDING, DispatchStatus.QUEUED, limit],
        );
        // node-postgres returns [rows, affectedCount] for UPDATE ... RETURNING.
        const due: CommunicationDispatch[] = Array.isArray(claimed?.[0]) ? claimed[0] : claimed;

        for (const row of due) {
            out.attempted += 1;
            try {
                const ok = await this.deliver(row);
                if (ok) out.sent += 1; else out.failed += 1;
            } catch (err: any) {
                out.failed += 1;
                // `attempts` was incremented when the row was claimed, so it is
                // already correct here; only the outcome needs writing.
                await this.dispatches.update(row.id, {
                    reason: String(err?.message ?? err).slice(0, 200),
                    status: row.attempts >= 3 ? DispatchStatus.FAILED : DispatchStatus.QUEUED,
                });
            }
        }
        return out;
    }

    private static async deliver(row: CommunicationDispatch): Promise<boolean> {
        const trigger = await this.triggers.findOne({ where: { key: row.triggerKey } });
        if (!trigger) {
            await this.dispatches.update(row.id, { status: DispatchStatus.FAILED, reason: 'no_trigger' });
            return false;
        }

        // Re-check the kill switch and the cohort at send time, not only at
        // claim time. A channel switched off, or a passenger removed from the
        // cohort, must stop messages that are already queued.
        const reach = await this.mayReach(trigger, row.userId);
        if (!reach.ok) {
            await this.dispatches.update(row.id, { status: DispatchStatus.SKIPPED, reason: reach.reason });
            return false;
        }

        const passenger = await AppDataSource.getRepository(User).findOne({ where: { id: row.userId } });
        if (!passenger) {
            await this.dispatches.update(row.id, { status: DispatchStatus.SKIPPED, reason: 'passenger_not_found' });
            return false;
        }

        const consent = await this.consentFor(
            trigger.consentClass, row.userId, row.channel,
            row.channel === 'email' ? (passenger.email ?? null) : null,
        );
        if (!consent.ok) {
            await this.dispatches.update(row.id, { status: DispatchStatus.SKIPPED, reason: consent.reason });
            return false;
        }

        const ctx = await this.contextFor(row, passenger);

        if (row.channel === 'email') return this.deliverEmail(row, trigger, passenger.email ?? null, ctx);
        if (row.channel === 'push')  return this.deliverPush(row, trigger, ctx);

        await this.dispatches.update(row.id, { status: DispatchStatus.SKIPPED, reason: 'channel_disabled' });
        return false;
    }

    private static async contextFor(row: CommunicationDispatch, passenger: User): Promise<ServiceContext> {
        const cfg = loadCommunicationsConfig();
        let pickupArea: string | null = null;
        let destinationArea: string | null = null;

        if (row.rideId) {
            const ride = await AppDataSource.getRepository(Ride).findOne({ where: { rideId: row.rideId } });
            // Structured locality only. A parsed historical address is often a
            // plus code or a placeholder, and naming the wrong place in a
            // thank-you reads worse than naming none.
            pickupArea = ride?.pickupSubLocality ?? ride?.pickupLocality ?? null;
            destinationArea = ride?.destinationSubLocality ?? ride?.destinationLocality ?? null;
        }

        return {
            firstName: passenger.firstName ?? null,
            pickupArea,
            destinationArea,
            appUrl: cfg.publicBaseUrl.replace('api.', 'www.'),
            supportEmail: cfg.replyToAddress,
            preferencesUrl: `${cfg.publicBaseUrl}/comms/preferences`,
        };
    }

    private static async deliverEmail(
        row: CommunicationDispatch,
        trigger: CommunicationTrigger,
        to: string | null,
        ctx: ServiceContext,
    ): Promise<boolean> {
        if (!to) {
            await this.dispatches.update(row.id, { status: DispatchStatus.SKIPPED, reason: 'no_email' });
            return false;
        }

        const rendered = renderServiceTemplate(trigger.templateKey, ctx);
        if (!rendered) {
            await this.dispatches.update(row.id, { status: DispatchStatus.FAILED, reason: 'no_template' });
            return false;
        }

        const identity = senderIdentity();
        const result = await emailProvider().send({
            to,
            subject: rendered.subject,
            html: rendered.html,
            text: rendered.text,
            fromName: identity.fromName,
            fromAddress: identity.fromAddress,
            replyTo: identity.replyTo,
            // Ties the provider's retry to this exact row, so an ambiguous
            // timeout cannot produce two emails.
            idempotencyKey: `${row.triggerKey}:${row.dedupeKey}:${row.channel}`,
        });

        if (result.ok) {
            await this.dispatches.update(row.id, {
                status: DispatchStatus.SENT, sentAt: new Date(),
                providerMessageId: result.messageId ?? null, reason: null,
            });
            await this.triggers.increment({ id: trigger.id }, 'sentCount', 1);
            return true;
        }

        const permanent = result.retryable === false;
        await this.dispatches.update(row.id, {
            reason: (result.error ?? 'send failed').slice(0, 200),
            status: permanent || row.attempts >= 3 ? DispatchStatus.FAILED : DispatchStatus.QUEUED,
        });
        if (permanent || row.attempts >= 3) {
            await this.triggers.increment({ id: trigger.id }, 'failedCount', 1);
        }
        return false;
    }

    private static async deliverPush(
        row: CommunicationDispatch,
        trigger: CommunicationTrigger,
        ctx: ServiceContext,
    ): Promise<boolean> {
        const copy = pushForTrigger(trigger.key, ctx);
        if (!copy) {
            await this.dispatches.update(row.id, { status: DispatchStatus.FAILED, reason: 'no_template' });
            return false;
        }

        const result = await NotificationService.sendToUser(
            row.userId, UserRole.PASSENGER, copy.title, copy.body,
            {
                type: 'lifecycle',
                trigger: trigger.key,
                rideId: row.rideId ?? '',
                // Marketing yields; service lifecycle push is operational-adjacent
                // but still must never outrank a ride alert.
                priority: String(
                    trigger.consentClass === ConsentClass.SERVICE
                        ? NotificationPriority.OPERATIONAL
                        : NotificationPriority.MARKETING,
                ),
            },
        );

        // No device token is not a failure — it is a passenger who has not
        // installed or has revoked notifications. Recorded as skipped so the
        // delivery rate is not distorted by people we could never reach.
        if (!result.attempted) {
            await this.dispatches.update(row.id, {
                status: DispatchStatus.SKIPPED,
                reason: result.reason ?? 'no_destination',
            });
            return false;
        }

        if (result.successCount > 0) {
            await this.dispatches.update(row.id, {
                status: DispatchStatus.SENT, sentAt: new Date(), reason: null,
            });
            await this.triggers.increment({ id: trigger.id }, 'sentCount', 1);
            return true;
        }

        await this.dispatches.update(row.id, {
            reason: 'all tokens failed',
            status: row.attempts >= 3 ? DispatchStatus.FAILED : DispatchStatus.QUEUED,
        });
        if (row.attempts >= 3) await this.triggers.increment({ id: trigger.id }, 'failedCount', 1);
        return false;
    }

    // ── Reporting ───────────────────────────────────────────────────────

    /** Per-automation counters for the admin Automations page. */
    static async summary(): Promise<Array<Record<string, unknown>>> {
        const triggers = await this.triggers.find({ order: { createdAt: 'ASC' } });
        const stats = await AppDataSource.query(`
            SELECT "triggerKey",
                   COUNT(*) FILTER (WHERE "createdAt" > now() - interval '24 hours')::int AS "triggered24h",
                   COUNT(*) FILTER (WHERE status = 'sent'    AND "createdAt" > now() - interval '24 hours')::int AS "sent24h",
                   COUNT(*) FILTER (WHERE status = 'failed'  AND "createdAt" > now() - interval '24 hours')::int AS "failed24h",
                   COUNT(*) FILTER (WHERE status = 'queued')::int  AS "pending",
                   COUNT(*) FILTER (WHERE status = 'skipped' AND "createdAt" > now() - interval '24 hours')::int AS "skipped24h",
                   COUNT(*) FILTER (WHERE status = 'sent')::int    AS "sentTotal"
              FROM communication_dispatch GROUP BY "triggerKey"`);
        const byKey = new Map(stats.map((s: any) => [s.triggerKey, s]));

        return triggers.map((t) => {
            const s: any = byKey.get(t.key) ?? {};
            const sent = Number(s.sentTotal ?? 0);
            const failed = Number(s.failed24h ?? 0);
            return {
                key: t.key,
                name: t.name,
                description: t.description,
                consentClass: t.consentClass,
                channels: t.channels,
                templateKey: t.templateKey,
                triggerCodes: t.triggerCodes,
                enabled: t.enabled,
                mode: t.mode,
                delayMinutes: t.delayMinutes,
                cooldownMinutes: t.cooldownMinutes,
                frequencyCap: t.frequencyCap,
                frequencyWindowDays: t.frequencyWindowDays,
                lastTriggeredAt: t.lastTriggeredAt?.toISOString() ?? null,
                triggered24h: Number(s.triggered24h ?? 0),
                sent24h: Number(s.sent24h ?? 0),
                failed24h: failed,
                skipped24h: Number(s.skipped24h ?? 0),
                pending: Number(s.pending ?? 0),
                sentTotal: sent,
                deliveryRate: sent + failed > 0 ? Math.round((sent / (sent + failed)) * 100) : null,
            };
        });
    }

    /** One passenger's communication history, for support. */
    static async historyFor(userId: string, limit = 100): Promise<Array<Record<string, unknown>>> {
        const rows = await this.dispatches.find({
            where: { userId }, order: { createdAt: 'DESC' }, take: Math.min(limit, 300),
        });
        const triggers = await this.triggers.find();
        const names = new Map(triggers.map((t) => [t.key, t.name]));

        return rows.map((r) => ({
            at: r.createdAt.toISOString(),
            trigger: r.triggerKey,
            name: names.get(r.triggerKey) ?? r.triggerKey,
            channel: r.channel,
            status: r.status,
            reason: r.reason,
            rideId: r.rideId,
            outcomeReason: r.outcomeReason,
            mode: r.mode,
            sentAt: r.sentAt?.toISOString() ?? null,
        }));
    }
}
