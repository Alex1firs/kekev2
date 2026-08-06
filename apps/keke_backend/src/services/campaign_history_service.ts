/**
 * A campaign's permanent record.
 *
 * ── Append-only, deliberately ────────────────────────────────────────────
 * There is `record()` and there are reads. No update, no delete, no
 * correction. A history somebody could tidy up would be worth nothing on the
 * day it matters, which is the day a passenger complains and somebody asks who
 * approved it.
 *
 * ── Recording must never fail the action it describes ────────────────────
 * `record()` swallows its errors. Refusing to approve a campaign because the
 * history table was briefly unavailable would trade a real operation for a
 * bookkeeping entry. The entry is worth a lot; it is not worth that.
 *
 * ── The actor's name is copied, not referenced ───────────────────────────
 * Staff leave. A foreign key to a row somebody later deletes turns "approved by
 * Amaka" into "approved by 4f3c-…", which is not an answer.
 */

import { AppDataSource } from '../config/data_source';
import { CommunicationCampaignEvent } from '../models/CommunicationCampaignEvent';
import { StaffUser } from '../models/StaffUser';

export const CampaignAction = {
    CREATED: 'created',
    EDITED: 'edited',
    CONTENT_EDITED: 'content_edited',
    CHANNEL_ENABLED: 'channel_enabled',
    CHANNEL_DISABLED: 'channel_disabled',
    APPROVAL_REQUESTED: 'approval_requested',
    APPROVED: 'approved',
    REJECTED: 'rejected',
    SCHEDULED: 'scheduled',
    RESCHEDULED: 'rescheduled',
    SCHEDULE_CANCELLED: 'schedule_cancelled',
    SEND_STARTED: 'send_started',
    PAUSED: 'paused',
    RESUMED: 'resumed',
    COMPLETED: 'completed',
    CANCELLED: 'cancelled',
    FAILED: 'failed',
    TEST_SENT: 'test_sent',
    DUPLICATED: 'duplicated',
} as const;

export type CampaignActionValue = typeof CampaignAction[keyof typeof CampaignAction];

export interface FieldChange { field: string; from: unknown; to: unknown }

export interface RecordInput {
    campaignId: string;
    action: CampaignActionValue | string;
    actorStaffId?: string | null;
    channel?: string | null;
    note?: string | null;
    changes?: FieldChange[] | null;
    ipAddress?: string | null;
    userAgent?: string | null;
}

/** Fields whose values must never be copied into a history row. */
const NEVER_DIFF = new Set(['updatedAt', 'createdAt', 'id']);

export class CampaignHistoryService {
    private static get repo() { return AppDataSource.getRepository(CommunicationCampaignEvent); }

    static async record(input: RecordInput): Promise<void> {
        try {
            let actorName: string | null = null;
            let actorRole: string | null = null;

            if (input.actorStaffId) {
                const staff: any = await AppDataSource.getRepository(StaffUser)
                    .findOne({ where: { id: input.actorStaffId } });
                actorName = staff?.fullName ?? staff?.name ?? staff?.email ?? null;
                actorRole = staff?.primaryRole ?? staff?.role ?? null;
            }

            await this.repo.save(this.repo.create({
                campaignId: input.campaignId,
                action: input.action,
                actorStaffId: input.actorStaffId ?? null,
                actorName,
                actorRole,
                channel: input.channel ?? null,
                note: input.note ? String(input.note).slice(0, 500) : null,
                changes: input.changes?.length ? input.changes : null,
                ipAddress: input.ipAddress ?? null,
                userAgent: input.userAgent ? String(input.userAgent).slice(0, 300) : null,
            }));
        } catch (err: any) {
            // See the note at the top: never fail the action being recorded.
            console.error('[CAMPAIGN_HISTORY] could not record', input.action, err?.message);
        }
    }

    /**
     * Work out what actually changed between two versions of a campaign.
     *
     * Only fields present in `next` are considered, so a PATCH that touched
     * three fields does not produce a diff claiming the other twenty were
     * "changed" to the values they already had.
     */
    static diff(prev: Record<string, any>, next: Record<string, any>): FieldChange[] {
        const changes: FieldChange[] = [];
        for (const [field, to] of Object.entries(next)) {
            if (NEVER_DIFF.has(field)) continue;
            const from = prev?.[field];
            if (this.same(from, to)) continue;
            changes.push({ field, from: this.summarise(from), to: this.summarise(to) });
        }
        return changes;
    }

    private static same(a: unknown, b: unknown): boolean {
        if (a === b) return true;
        if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
        if (a == null && b == null) return true;
        if (typeof a === 'object' && typeof b === 'object') {
            try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
        }
        return false;
    }

    /**
     * Keep values readable and bounded.
     *
     * An email body is tens of kilobytes; storing two copies of it on every
     * keystroke-sized edit would make the history table larger than everything
     * it describes. Long values become a length and a head, which is enough to
     * see that the body changed and roughly how.
     */
    private static summarise(v: unknown): unknown {
        if (typeof v === 'string' && v.length > 300) {
            return `${v.slice(0, 300)}… (${v.length} chars)`;
        }
        if (v instanceof Date) return v.toISOString();
        return v ?? null;
    }

    /** The whole history of one campaign, oldest first — it reads as a story. */
    static async forCampaign(campaignId: string) {
        const rows = await this.repo.find({
            where: { campaignId },
            order: { createdAt: 'ASC' },
        });
        return rows.map((r) => ({
            id: r.id,
            action: r.action,
            actor: r.actorStaffId
                ? { id: r.actorStaffId, name: r.actorName, role: r.actorRole }
                : { id: null, name: 'KekeRide (automatic)', role: 'system' },
            channel: r.channel,
            note: r.note,
            changes: r.changes ?? [],
            ipAddress: r.ipAddress,
            userAgent: r.userAgent,
            at: r.createdAt.toISOString(),
        }));
    }

    /**
     * The named people, extracted from the history.
     *
     * Reads the log rather than the campaign's own `approvedByStaffId` columns,
     * because the log is what survives a later edit and is the thing being
     * asserted. If the two ever disagree, the log is right.
     */
    static async attribution(campaignId: string) {
        const events = await this.forCampaign(campaignId);
        const firstBy = (action: string) => {
            const e = events.find((x) => x.action === action);
            return e ? { name: e.actor.name, id: e.actor.id, at: e.at } : null;
        };
        const lastBy = (action: string) => {
            const matches = events.filter((x) => x.action === action);
            const e = matches[matches.length - 1];
            return e ? { name: e.actor.name, id: e.actor.id, at: e.at } : null;
        };

        return {
            created: firstBy(CampaignAction.CREATED),
            lastEdited: lastBy(CampaignAction.EDITED) ?? lastBy(CampaignAction.CONTENT_EDITED),
            approved: lastBy(CampaignAction.APPROVED),
            cancelled: lastBy(CampaignAction.CANCELLED),
            paused: lastBy(CampaignAction.PAUSED),
            resumed: lastBy(CampaignAction.RESUMED),
            editCount: events.filter((e) =>
                e.action === CampaignAction.EDITED || e.action === CampaignAction.CONTENT_EDITED).length,
            totalEvents: events.length,
        };
    }
}
