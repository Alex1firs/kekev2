/**
 * Sending a campaign to yourself, and to nobody else.
 *
 * ── The safety property, and how it is achieved ──────────────────────────
 * A test send must be structurally incapable of reaching a passenger — not
 * merely careful about it. Two independent guarantees, either of which alone
 * would be sufficient:
 *
 *   1. The recipient list never comes from the audience. It comes from the
 *      caller's own staff address, an allow-list of internal testers, or
 *      addresses typed by hand. `AudienceService` is not imported here at all.
 *
 *   2. Every address is checked against the passenger table before anything is
 *      sent. If it belongs to a passenger, the send is refused — even if a
 *      staff member typed it themselves, and even if it is also their own
 *      address. A tester who happens to have a passenger account cannot be used
 *      as a route to a real inbox.
 *
 * The second check is what makes the first unnecessary, and vice versa. That is
 * the point of having both.
 */

import { In } from 'typeorm';
import { AppDataSource } from '../config/data_source';
import { User, UserRole } from '../models/User';
import { StaffUser } from '../models/StaffUser';
import { CampaignChannelKind } from '../models/CommunicationCampaign';
import { MultiChannelCampaignService } from './multichannel_campaign_service';
import { emailProvider, senderIdentity } from './email_provider';
import { AuditService, AuditActor } from './audit_service';
import { AppError, ErrorCode } from '../utils/errors';

/** A test may never go to more than this many addresses. */
const MAX_TEST_RECIPIENTS = 10;

export interface TestSendResult {
    sent: Array<{ address: string; channel: string; messageId?: string | null }>;
    refused: Array<{ address: string; reason: string }>;
}

export class CampaignTestSend {
    /**
     * Send the campaign's real content to staff addresses.
     *
     * Subject-prefixed [TEST] so a forwarded copy cannot be mistaken for a live
     * campaign, and the unsubscribe links point at a PREVIEW token that
     * resolves to nobody.
     */
    static async send(
        actor: AuditActor,
        campaignId: string,
        addresses: string[],
        ctx: Record<string, unknown> = {},
    ): Promise<TestSendResult> {
        const campaign = await MultiChannelCampaignService.get(campaignId);
        const wanted = [...new Set(
            (addresses ?? []).map((a) => String(a ?? '').trim().toLowerCase()).filter(Boolean),
        )];

        if (wanted.length === 0) {
            throw new AppError(400, ErrorCode.MISSING_FIELDS, 'Give at least one test address.');
        }
        if (wanted.length > MAX_TEST_RECIPIENTS) {
            throw new AppError(400, ErrorCode.VALIDATION_ERROR,
                `A test may go to at most ${MAX_TEST_RECIPIENTS} addresses. This is a test, not a send.`);
        }

        const refused: TestSendResult['refused'] = [];
        const allowed: string[] = [];

        /*
         * The guarantee. Any address belonging to a passenger is refused,
         * whoever asked for it — a hand-typed list is exactly the route by
         * which somebody would otherwise "test" a campaign on a real customer.
         */
        const passengers = await AppDataSource.getRepository(User).find({
            where: { email: In(wanted), role: UserRole.PASSENGER },
            select: ['email'],
        });
        const passengerAddresses = new Set(passengers.map((p) => p.email.toLowerCase()));

        // Known staff addresses, so an obvious typo is caught rather than sent.
        const staff = await AppDataSource.getRepository(StaffUser).find({ select: ['email'] });
        const staffAddresses = new Set(staff.map((s) => s.email.toLowerCase()));

        for (const address of wanted) {
            if (!address.includes('@')) {
                refused.push({ address, reason: 'not_an_email' });
                continue;
            }
            if (passengerAddresses.has(address)) {
                refused.push({ address, reason: 'belongs_to_a_passenger' });
                continue;
            }
            if (!staffAddresses.has(address) && !this.isInternalDomain(address)) {
                /*
                 * Not staff and not a KekeRide address. Refused rather than
                 * allowed: an arbitrary external address is how a campaign
                 * reaches somebody who never consented, and "I was only
                 * testing" is not a defence they would accept.
                 */
                refused.push({ address, reason: 'not_an_internal_address' });
                continue;
            }
            allowed.push(address);
        }

        if (allowed.length === 0) {
            throw new AppError(400, ErrorCode.VALIDATION_ERROR,
                refused.some((r) => r.reason === 'belongs_to_a_passenger')
                    ? 'That address belongs to a passenger. A test can only go to staff.'
                    : 'No usable test address. Use a staff account or a kekeride.ng address.');
        }

        const previews = await MultiChannelCampaignService.previews(campaignId);
        const sender = senderIdentity();
        const sent: TestSendResult['sent'] = [];

        /*
         * Only email is actually delivered. A test push would need a device
         * token belonging to a tester, and a test SMS would cost money on a
         * channel with no provider — both are shown as rendered previews in the
         * admin screen instead, which is what a reviewer actually reads.
         */
        const email = (previews as any).email;
        if (email) {
            for (const address of allowed) {
                const result = await emailProvider().send({
                    to: address,
                    subject: `[TEST] ${email.subject ?? campaign.name}`,
                    html: email.html,
                    text: email.text,
                    fromName: sender.fromName,
                    fromAddress: sender.fromAddress,
                    replyTo: sender.replyTo,
                    idempotencyKey: `test-${campaignId}-${address}-${Date.now()}`,
                });
                if (result.ok) {
                    sent.push({ address, channel: 'email', messageId: result.messageId });
                } else {
                    refused.push({ address, reason: result.error ?? 'provider_error' });
                }
            }
        }

        await MultiChannelCampaignService.markTested(campaignId);

        await AuditService.recordCritical({
            actor,
            action: 'CAMPAIGN_TEST_SENT',
            resourceType: 'COMMUNICATION_CAMPAIGN',
            resourceId: campaignId,
            // The addresses are staff, and recording them answers "who checked this".
            newValue: sent.map((s) => s.address).join(', ') || 'none',
            metadata: { refused: refused.length, channels: Object.keys(previews) },
            ...ctx,
        });

        return { sent, refused };
    }

    /** A KekeRide address, for a tester who has no staff account yet. */
    private static isInternalDomain(address: string): boolean {
        return /@(.+\.)?kekeride\.ng$/i.test(address);
    }
}
