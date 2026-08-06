/**
 * Campaigns on a calendar.
 *
 * ── Which date a campaign is placed on ───────────────────────────────────
 * Whichever one is true of it, in this order: when it was sent, when it is
 * scheduled to send, otherwise when it was created. A draft sits on the day
 * somebody started it, because that is the only date it has, and a completed
 * campaign sits on the day it actually went — not the day it was booked for,
 * which may be different if it was rescheduled or delayed.
 *
 * The rule is returned with each entry as `anchor`, so the calendar can say
 * why something is where it is rather than leaving an operator to guess.
 *
 * ── Rescheduling is the only write ───────────────────────────────────────
 * Drag-and-drop moves `scheduledAt`, and nothing else. It refuses any campaign
 * that is not in a schedulable state and any date in the past — dragging
 * something to last Tuesday should not quietly mean "send immediately", which
 * is what a naive implementation does.
 *
 * Approved content is not re-approved by moving it, but the move is recorded in
 * the campaign's history with both dates, because "who moved the Christmas
 * promotion to Boxing Day" is a question somebody will eventually ask.
 */

import { Between, In } from 'typeorm';
import { AppDataSource } from '../config/data_source';
import { CommunicationCampaign, CampaignStatus } from '../models/CommunicationCampaign';
import { CommunicationCampaignChannel } from '../models/CommunicationCampaign';
import { CampaignHistoryService, CampaignAction } from './campaign_history_service';

/** Statuses whose scheduled date may be moved. */
export const RESCHEDULABLE: CampaignStatus[] = [
    CampaignStatus.SCHEDULED,
    CampaignStatus.APPROVED,
    CampaignStatus.DRAFT,
    CampaignStatus.AWAITING_APPROVAL,
];

export type CalendarScale = 'day' | 'week' | 'month';

export interface CalendarEntry {
    id: string;
    name: string;
    status: CampaignStatus;
    /** The date this entry is drawn on. */
    date: string;
    /** Why it is on that date. */
    anchor: 'sent' | 'scheduled' | 'created';
    scheduledAt: string | null;
    timezone: string | null;
    channels: string[];
    audienceSize: number | null;
    canReschedule: boolean;
    /** Present when canReschedule is false: why not. */
    lockReason?: string;
}

export class CampaignCalendarService {
    private static get repo() { return AppDataSource.getRepository(CommunicationCampaign); }

    /**
     * The window a scale covers, anchored on a date.
     *
     * Weeks start on Monday. Nigeria's working week does, and a calendar whose
     * weekend is split across two rows is read wrong at a glance.
     */
    static windowFor(scale: CalendarScale, anchorISO: string): { from: Date; to: Date } {
        const anchor = new Date(anchorISO);
        if (Number.isNaN(anchor.getTime())) throw new Error('Invalid date.');

        const from = new Date(anchor);
        from.setHours(0, 0, 0, 0);
        const to = new Date(from);

        if (scale === 'day') {
            to.setDate(to.getDate() + 1);
        } else if (scale === 'week') {
            // getDay(): 0 = Sunday. Shift so Monday is the first column.
            const shift = (from.getDay() + 6) % 7;
            from.setDate(from.getDate() - shift);
            to.setTime(from.getTime());
            to.setDate(to.getDate() + 7);
        } else {
            from.setDate(1);
            to.setTime(from.getTime());
            to.setMonth(to.getMonth() + 1);
        }
        return { from, to };
    }

    static async view(scale: CalendarScale, anchorISO: string, statuses?: CampaignStatus[]) {
        const { from, to } = this.windowFor(scale, anchorISO);

        /*
         * Fetch on any of the three anchor dates, then place each campaign on
         * the one that applies. Filtering on a single column would drop a
         * campaign that was created before the window and sent inside it.
         */
        const qb = this.repo.createQueryBuilder('c')
            .where(
                '(c."sendCompletedAt" >= :from AND c."sendCompletedAt" < :to) '
                + 'OR (c."scheduledAt" >= :from AND c."scheduledAt" < :to) '
                + 'OR (c."createdAt" >= :from AND c."createdAt" < :to)',
                { from, to },
            );

        if (statuses?.length) qb.andWhere('c.status IN (:...st)', { st: statuses });

        const campaigns = await qb.orderBy('c."createdAt"', 'ASC').getMany();
        if (campaigns.length === 0) {
            return { scale, from: from.toISOString(), to: to.toISOString(), entries: [], counts: this.emptyCounts() };
        }

        const channels = await AppDataSource.getRepository(CommunicationCampaignChannel)
            .find({ where: { campaignId: In(campaigns.map((c) => c.id)) } });
        const channelsOf = new Map<string, string[]>();
        for (const ch of channels) {
            if (!ch.enabled) continue;
            const list = channelsOf.get(ch.campaignId) ?? [];
            list.push(String(ch.channel));
            channelsOf.set(ch.campaignId, list);
        }

        const entries: CalendarEntry[] = campaigns.map((c) => {
            const { date, anchor } = this.anchorOf(c);
            const lock = this.rescheduleLock(c);
            return {
                id: c.id,
                name: c.name,
                status: c.status,
                date,
                anchor,
                scheduledAt: c.scheduledAt ? c.scheduledAt.toISOString() : null,
                timezone: c.scheduleTimezone,
                channels: channelsOf.get(c.id) ?? [],
                audienceSize: (c as any).eligibleCount ?? null,
                canReschedule: lock == null,
                ...(lock ? { lockReason: lock } : {}),
            };
        });

        const counts = this.emptyCounts();
        for (const e of entries) counts[e.status] = (counts[e.status] ?? 0) + 1;

        return { scale, from: from.toISOString(), to: to.toISOString(), entries, counts };
    }

    private static anchorOf(c: CommunicationCampaign): { date: string; anchor: CalendarEntry['anchor'] } {
        if (c.sendCompletedAt) return { date: c.sendCompletedAt.toISOString(), anchor: 'sent' };
        if (c.scheduledAt) return { date: c.scheduledAt.toISOString(), anchor: 'scheduled' };
        return { date: c.createdAt.toISOString(), anchor: 'created' };
    }

    /** Null when it may be moved; otherwise the reason it may not. */
    private static rescheduleLock(c: CommunicationCampaign): string | null {
        if (!RESCHEDULABLE.includes(c.status)) {
            return `A ${c.status.replace(/_/g, ' ')} campaign cannot be rescheduled.`;
        }
        if (c.sendStartedAt) return 'Sending has already begun.';
        return null;
    }

    /**
     * Move a campaign's send time.
     *
     * Refuses the past outright. A drag onto a day that has gone is almost
     * always a mis-drop, and the alternative reading — "send it now" — is the
     * single most expensive thing this screen could do by accident.
     */
    static async reschedule(input: {
        campaignId: string;
        toISO: string;
        actorStaffId: string;
        ipAddress?: string | null;
        userAgent?: string | null;
    }) {
        const campaign = await this.repo.findOne({ where: { id: input.campaignId } });
        if (!campaign) throw new Error('Campaign not found.');

        const lock = this.rescheduleLock(campaign);
        if (lock) throw new Error(lock);

        const next = new Date(input.toISO);
        if (Number.isNaN(next.getTime())) throw new Error('Invalid date.');
        if (next.getTime() < Date.now()) {
            throw new Error('That date has already passed. Pick a future time.');
        }

        const from = campaign.scheduledAt;
        campaign.scheduledAt = next;
        /*
         * A campaign that was approved but unscheduled becomes scheduled by
         * being placed. A draft stays a draft: giving it a date does not mean
         * it has been approved to go out on that date.
         */
        if (campaign.status === CampaignStatus.APPROVED) {
            campaign.status = CampaignStatus.SCHEDULED;
        }
        await this.repo.save(campaign);

        await CampaignHistoryService.record({
            campaignId: campaign.id,
            action: from ? CampaignAction.RESCHEDULED : CampaignAction.SCHEDULED,
            actorStaffId: input.actorStaffId,
            note: 'Moved on the calendar.',
            changes: [{
                field: 'scheduledAt',
                from: from ? from.toISOString() : null,
                to: next.toISOString(),
            }],
            ipAddress: input.ipAddress ?? null,
            userAgent: input.userAgent ?? null,
        });

        return {
            id: campaign.id,
            status: campaign.status,
            scheduledAt: campaign.scheduledAt.toISOString(),
            movedFrom: from ? from.toISOString() : null,
        };
    }

    private static emptyCounts(): Record<string, number> {
        return {
            [CampaignStatus.DRAFT]: 0,
            [CampaignStatus.AWAITING_APPROVAL]: 0,
            [CampaignStatus.APPROVED]: 0,
            [CampaignStatus.SCHEDULED]: 0,
            [CampaignStatus.SENDING]: 0,
            [CampaignStatus.PAUSED]: 0,
            [CampaignStatus.COMPLETED]: 0,
            [CampaignStatus.CANCELLED]: 0,
            [CampaignStatus.FAILED]: 0,
        };
    }
}
