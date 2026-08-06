/**
 * What would happen if this campaign were released.
 *
 * ── Why a simulator rather than a count ──────────────────────────────────
 * "1,200 recipients" is not enough to approve a send on. The questions somebody
 * needs answered before they release a message to real people are: how many get
 * it on each channel, how many will fail and why, what will it cost, and how
 * long will it run. A number that answers only the first invites the other
 * three to be discovered afterwards.
 *
 * The estimates here are deliberately conservative and deliberately explained.
 * A prediction presented without its basis is a prediction nobody can argue
 * with, and the ones worth arguing with are exactly the ones that stop a bad
 * send.
 */

import { AppDataSource } from '../config/data_source';
import { DeviceToken } from '../models/DeviceToken';
import { User } from '../models/User';
import { CampaignChannelKind } from '../models/CommunicationCampaign';
import { MultiChannelCampaignService } from './multichannel_campaign_service';
import { analyseSms } from './channel_content';
import { loadCommunicationsConfig } from '../config/communications_config';
import { In } from 'typeorm';

const SMS_COST_PER_SEGMENT = Number(process.env.SMS_COST_PER_SEGMENT || 4);

/**
 * Historic failure rates, used only to set expectations.
 *
 * These are industry-typical rather than measured, because KekeRide has sent no
 * campaigns yet and inventing a precise number from no data would be worse than
 * a rough one that says it is rough. Once real deliveries exist these should be
 * replaced by this platform's own figures — the field name says so.
 */
const ASSUMED_FAILURE_RATE = {
    email: 0.02,   // bounces and rejections
    push: 0.15,    // stale tokens, uninstalled apps
    in_app: 0,     // nothing to fail: it is shown or it is not
    sms: 0.03,     // unreachable numbers
};

export interface ChannelSimulation {
    channel: CampaignChannelKind;
    enabled: boolean;
    /** Passengers who pass consent, suppression and channel checks. */
    willReceive: number;
    /** Of the audience, how many this channel cannot reach, and why. */
    excluded: number;
    exclusions: Record<string, number>;
    /** Passengers with no usable destination — no token, no phone number. */
    noDestination: number;
    estimatedFailures: number;
    estimatedDelivered: number;
    estimatedCost: number;
    smsSegments?: number;
    /** Seconds, at the configured batch size and pause. */
    estimatedSeconds: number;
    sendEnabled: boolean;
    blockingIssues: string[];
}

export interface CampaignSimulation {
    campaignId: string;
    audienceSize: number;
    channels: ChannelSimulation[];
    totals: {
        /** Distinct passengers reached by at least one channel. */
        uniquePassengers: number;
        /** Messages sent. Higher than uniquePassengers when channels overlap. */
        totalDeliveries: number;
        estimatedDelivered: number;
        estimatedFailures: number;
        estimatedCost: number;
        estimatedSeconds: number;
    };
    /** Stated so nobody mistakes an estimate for a measurement. */
    assumptions: string[];
    warnings: string[];
}

export class CampaignSimulator {
    static async run(campaignId: string): Promise<CampaignSimulation> {
        const cfg = loadCommunicationsConfig();
        const resolved = await MultiChannelCampaignService.resolve(campaignId);

        const channels: ChannelSimulation[] = [];
        const warnings: string[] = [];

        for (const c of resolved.channels) {
            /*
             * Consent is not enough. A passenger who allowed push but has no
             * registered device cannot be reached, and counting them as a
             * recipient would overstate the campaign — and, for SMS, its cost.
             */
            const noDestination = c.enabled
                ? await this.countWithoutDestination(c.channel, c.eligible)
                : 0;

            const reachable = Math.max(0, c.eligible - noDestination);
            const rate = ASSUMED_FAILURE_RATE[c.channel as keyof typeof ASSUMED_FAILURE_RATE] ?? 0;
            const estimatedFailures = Math.round(reachable * rate);

            const smsSegments = c.channel === CampaignChannelKind.SMS ? (c.segments ?? 0) : undefined;
            const estimatedCost = c.channel === CampaignChannelKind.SMS
                ? (smsSegments ?? 0) * reachable * SMS_COST_PER_SEGMENT
                : 0;

            /*
             * Time is set by the batch size and the pause between batches, not
             * by the provider. It is what tells somebody whether a campaign
             * released at 5pm finishes before the evening rush.
             */
            const batches = Math.ceil(reachable / Math.max(1, cfg.batchSize));
            const estimatedSeconds = batches === 0
                ? 0
                : Math.round((batches * cfg.batchPauseMs) / 1000) + batches;

            channels.push({
                channel: c.channel,
                enabled: c.enabled,
                willReceive: reachable,
                excluded: c.excluded,
                exclusions: c.exclusions,
                noDestination,
                estimatedFailures,
                estimatedDelivered: reachable - estimatedFailures,
                estimatedCost,
                smsSegments,
                estimatedSeconds,
                sendEnabled: c.sendEnabled,
                blockingIssues: c.issues.filter((i) => i.severity === 'error').map((i) => i.message),
            });

            if (c.enabled && reachable === 0) {
                warnings.push(`${c.channel}: nobody would receive this.`);
            }
            if (c.enabled && noDestination > 0) {
                warnings.push(
                    `${c.channel}: ${noDestination} consenting passenger(s) have no `
                    + `${c.channel === CampaignChannelKind.SMS ? 'phone number' : 'registered device'}.`,
                );
            }
        }

        const enabled = channels.filter((c) => c.enabled);
        const cost = enabled.reduce((n, c) => n + c.estimatedCost, 0);
        if (cost > 0) {
            warnings.push(`This campaign would cost about ₦${cost.toLocaleString()} to send.`);
        }

        return {
            campaignId,
            audienceSize: resolved.audienceSize,
            channels,
            totals: {
                uniquePassengers: resolved.audienceSize,
                totalDeliveries: enabled.reduce((n, c) => n + c.willReceive, 0),
                estimatedDelivered: enabled.reduce((n, c) => n + c.estimatedDelivered, 0),
                estimatedFailures: enabled.reduce((n, c) => n + c.estimatedFailures, 0),
                estimatedCost: cost,
                // Channels run one after another, so the times add.
                estimatedSeconds: enabled.reduce((n, c) => n + c.estimatedSeconds, 0),
            },
            assumptions: [
                `Failure rates are industry estimates, not KekeRide's own — no campaign has been sent yet. `
                + `Email ${ASSUMED_FAILURE_RATE.email * 100}%, push ${ASSUMED_FAILURE_RATE.push * 100}%, `
                + `SMS ${ASSUMED_FAILURE_RATE.sms * 100}%.`,
                `Timing assumes ${cfg.batchSize} recipients per batch with a `
                + `${cfg.batchPauseMs}ms pause, and excludes provider queueing.`,
                cost > 0
                    ? `SMS is costed at ₦${SMS_COST_PER_SEGMENT} per segment per recipient.`
                    : 'No channel in this campaign has a per-recipient cost.',
                'Eligibility is re-checked for every recipient at send time, so these '
                + 'numbers can only fall between now and then — never rise.',
            ],
            warnings,
        };
    }

    /**
     * Consenting passengers this channel still cannot physically reach.
     *
     * Push needs a registered device token; SMS needs a phone number. Consent
     * without a destination is a recipient who would silently be skipped, and
     * counting them would overstate both the reach and the bill.
     */
    private static async countWithoutDestination(
        channel: CampaignChannelKind, eligible: number,
    ): Promise<number> {
        if (eligible === 0) return 0;

        if (channel === CampaignChannelKind.PUSH) {
            const withTokens = await AppDataSource.getRepository(DeviceToken)
                .createQueryBuilder('t')
                .select('COUNT(DISTINCT t."userId")', 'n')
                .getRawOne<{ n: string }>();
            // An upper bound: some token holders will not be in this audience.
            // Reported as an estimate, and it errs towards fewer recipients.
            return Math.max(0, eligible - Number(withTokens?.n ?? 0));
        }

        if (channel === CampaignChannelKind.SMS) {
            const withPhone = await AppDataSource.getRepository(User)
                .createQueryBuilder('u')
                .where('u.phone IS NOT NULL')
                .andWhere("u.phone <> ''")
                .getCount();
            return Math.max(0, eligible - withPhone);
        }

        return 0;
    }
}
