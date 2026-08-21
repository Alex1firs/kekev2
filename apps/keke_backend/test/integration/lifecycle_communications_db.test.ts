/**
 * Lifecycle communications: what we send, what we refuse to send, and what a
 * communications fault is allowed to break (nothing).
 *
 * Every test here is a rule somebody could get wrong in a way a passenger would
 * notice — five apology emails from five taps, an apology for a ride they
 * cancelled themselves, a promotion to somebody who opted out, or a thank-you
 * for a training ride nobody actually took.
 */
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { randomUUID } from 'crypto';

import { User, UserRole } from '../../src/models/User';
import { Ride } from '../../src/models/Ride';
import { Setting } from '../../src/models/Setting';
import { DeviceToken } from '../../src/models/DeviceToken';
import { EmailSuppression } from '../../src/models/EmailSuppression';
import { PassengerCommunicationPreference } from '../../src/models/PassengerCommunicationPreference';
import { CommunicationTrigger, ConsentClass, AutomationMode } from '../../src/models/CommunicationTrigger';
import { CommunicationDispatch, DispatchStatus } from '../../src/models/CommunicationDispatch';
import { CommunicationTestSubject } from '../../src/models/CommunicationTestSubject';
import { CommunicationCampaign, CommunicationCampaignChannel } from '../../src/models/CommunicationCampaign';
import { EmailCampaignRecipient } from '../../src/models/EmailCampaignRecipient';
import { MarketingPushJob } from '../../src/models/MarketingPushJob';
import { CampaignStatus } from '../../src/models/EmailCampaign';

const TEST_DB = process.env.TEST_DATABASE_URL;
const describeDb = TEST_DB ? describe : describe.skip;
if (!TEST_DB) console.warn('[integration] TEST_DATABASE_URL not set — skipping lifecycle comms tests.');

const SCHEMA = 'lifecycle_comms_test';

describeDb('lifecycle communications (database)', () => {
    let ds: DataSource;
    let Lifecycle: typeof import('../../src/services/lifecycle_automation_service').LifecycleAutomationService;
    let Worker: typeof import('../../src/services/campaign_dispatch_worker').CampaignDispatchWorker;
    let Notifications: typeof import('../../src/services/notification_service').NotificationService;
    let setEmailProvider: typeof import('../../src/services/email_provider').setEmailProvider;

    /** Every email the fake provider was asked to send. */
    let outbox: Array<{ to: string; subject: string; html: string; text: string; idempotencyKey?: string }>;
    let providerBehaviour: 'ok' | 'throw' | 'fail';
    let pushCalls: Array<{ userId: string; title: string; body: string }>;
    let pushBehaviour: 'ok' | 'no_tokens' | 'all_fail';

    beforeAll(async () => {
        process.env.MARKETING_EMAIL_SEND_ENABLED = 'true';
        process.env.MARKETING_PUSH_SEND_ENABLED = 'true';

        const bootstrap = new DataSource({ type: 'postgres', url: TEST_DB });
        await bootstrap.initialize();
        await bootstrap.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
        await bootstrap.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public`);
        await bootstrap.destroy();

        ds = new DataSource({
            type: 'postgres', url: TEST_DB, schema: SCHEMA,
            entities: [
                User, Ride, Setting, DeviceToken, EmailSuppression,
                PassengerCommunicationPreference, CommunicationTrigger,
                CommunicationDispatch, CommunicationTestSubject,
                CommunicationCampaign, CommunicationCampaignChannel,
                EmailCampaignRecipient, MarketingPushJob,
            ],
            synchronize: true, logging: false,
            // Raw SQL in the services uses unqualified table names (correctly —
            // production runs in `public`), so the connection's search_path has
            // to put this suite's schema first. `public` stays on the path for
            // extension functions like uuid_generate_v4().
            extra: { options: `-c search_path=${SCHEMA},public` },
        });
        await ds.initialize();

        const dsMod = require('../../src/config/data_source');
        Object.defineProperty(dsMod, 'AppDataSource', { value: ds, writable: true });

        Lifecycle = require('../../src/services/lifecycle_automation_service').LifecycleAutomationService;
        Worker = require('../../src/services/campaign_dispatch_worker').CampaignDispatchWorker;
        Notifications = require('../../src/services/notification_service').NotificationService;
        setEmailProvider = require('../../src/services/email_provider').setEmailProvider;
    });

    afterAll(async () => {
        setEmailProvider?.(null);
        if (ds?.isInitialized) await ds.destroy();
    });

    beforeEach(async () => {
        for (const t of [
            'communication_dispatch', 'communication_trigger', 'communication_test_subject',
            'email_campaign_recipient', 'marketing_push_job', 'communication_campaign_channel',
            'communication_campaign', 'passenger_communication_preference', 'email_suppression',
            'device_token', 'ride', 'user', 'setting',
        ]) {
            await ds.query(`TRUNCATE TABLE ${SCHEMA}."${t}" CASCADE`);
        }

        outbox = [];
        providerBehaviour = 'ok';
        setEmailProvider({
            name: 'fake',
            isConfigured: () => true,
            async send(email: any) {
                if (providerBehaviour === 'throw') throw new Error('provider exploded');
                outbox.push(email);
                if (providerBehaviour === 'fail') return { ok: false, error: 'rejected', retryable: false };
                return { ok: true, messageId: `msg-${outbox.length}` };
            },
        } as any);

        pushCalls = [];
        pushBehaviour = 'ok';
        jest.spyOn(Notifications, 'sendToUser').mockImplementation(async (userId: string, _role: any, title: string, body: string) => {
            pushCalls.push({ userId, title, body });
            if (pushBehaviour === 'no_tokens') {
                return { attempted: false, tokenCount: 0, successCount: 0, failureCount: 0, reason: 'no_active_tokens' } as any;
            }
            if (pushBehaviour === 'all_fail') {
                return { attempted: true, tokenCount: 2, successCount: 0, failureCount: 2 } as any;
            }
            return { attempted: true, tokenCount: 1, successCount: 1, failureCount: 0 } as any;
        });
    });

    afterEach(() => { jest.restoreAllMocks(); });

    // ── Fixtures ────────────────────────────────────────────────────────

    async function passenger(over: Partial<User> = {}): Promise<User> {
        const id = randomUUID();
        const u = ds.getRepository(User).create({
            id, email: `p-${id.slice(0, 8)}@example.invalid`,
            firstName: 'Ada', lastName: 'Okeke',
            phone: `+23480${String(Date.now()).slice(-8)}`,
            role: UserRole.PASSENGER, password: 'x', ...over,
        } as any);
        await ds.getRepository(User).save(u);
        return u;
    }

    async function consent(userId: string, over: Partial<PassengerCommunicationPreference> = {}) {
        const repo = ds.getRepository(PassengerCommunicationPreference);
        await repo.save(repo.create({
            userId, marketing: true, promotionalOffers: true,
            marketingEmail: true, marketingPush: true, safetyAnnouncements: true, ...over,
        } as any));
    }

    async function ride(passengerId: string, over: Partial<Ride> = {}): Promise<string> {
        const rideId = `RIDE-${randomUUID().slice(0, 12)}`;
        await ds.getRepository(Ride).save(ds.getRepository(Ride).create({
            rideId, passengerId, driverId: randomUUID(),
            status: 'completed', fare: 1100, finalFare: 1100, paymentMode: 'cash',
            pickupSubLocality: 'Ochanja', destinationSubLocality: 'Nkpor',
            ...over,
        } as any));
        return rideId;
    }

    async function trigger(over: Partial<CommunicationTrigger> = {}): Promise<CommunicationTrigger> {
        const repo = ds.getRepository(CommunicationTrigger);
        return repo.save(repo.create({
            key: 'ride_completed', name: 'Ride completed',
            consentClass: ConsentClass.SERVICE, channels: ['email', 'push'],
            templateKey: 'ride_completed_thank_you', triggerCodes: ['COMPLETED'],
            enabled: true, mode: AutomationMode.PRODUCTION,
            delayMinutes: 0, cooldownMinutes: 0, frequencyCap: 0, frequencyWindowDays: 30,
            ...over,
        } as any));
    }

    const event = (rideId: string, passengerId: string, outcome: string) => ({
        type: outcome === 'COMPLETED' ? 'ride.completed' : 'ride.not_fulfilled',
        rideId, passengerId, outcomeReason: outcome,
        pickupArea: 'Ochanja', destinationArea: 'Nkpor',
        occurredAt: new Date().toISOString(),
    });

    const dispatches = () => ds.getRepository(CommunicationDispatch).find();

    async function suppress(email: string) {
        const repo = ds.getRepository(EmailSuppression);
        await repo.save(repo.create({
            email, reason: 'hard_bounce', source: 'webhook',
        } as any));
    }

    /** Run the full pipeline: claim, then deliver. */
    async function run(rideId: string, userId: string, outcome: string) {
        await Lifecycle.handleRideEvent(event(rideId, userId, outcome) as any);
        await Lifecycle.sendDue(100);
    }

    // ══ 1–2. Completion, exactly once ═══════════════════════════════════

    it('1. a completed ride produces exactly one email and one push', async () => {
        const p = await passenger();
        await trigger();
        await run(await ride(p.id), p.id, 'COMPLETED');

        expect(outbox).toHaveLength(1);
        expect(outbox[0].to).toBe(p.email);
        expect(outbox[0].subject).toContain('Thank you for riding');
        expect(pushCalls).toHaveLength(1);

        const rows = await dispatches();
        expect(rows.filter((r) => r.status === DispatchStatus.SENT)).toHaveLength(2);
    });

    it('2. a duplicate completion event sends nothing further', async () => {
        const p = await passenger();
        await trigger();
        const r = await ride(p.id);

        await run(r, p.id, 'COMPLETED');
        await run(r, p.id, 'COMPLETED');   // the socket fired twice

        expect(outbox).toHaveLength(1);
        expect(pushCalls).toHaveLength(1);
    });

    it('2b. two concurrent completion events still send once', async () => {
        const p = await passenger();
        await trigger();
        const r = await ride(p.id);

        await Promise.all([
            Lifecycle.handleRideEvent(event(r, p.id, 'COMPLETED') as any),
            Lifecycle.handleRideEvent(event(r, p.id, 'COMPLETED') as any),
        ]);
        await Lifecycle.sendDue(100);

        expect(outbox).toHaveLength(1);
    });

    // ══ 3–7. The right message for the right reason ═════════════════════

    it('3. NO_ELIGIBLE_DRIVER produces the recovery message', async () => {
        const p = await passenger();
        await trigger({
            key: 'ride_not_fulfilled', templateKey: 'ride_not_fulfilled_apology',
            triggerCodes: ['NO_ELIGIBLE_DRIVER', 'NO_DRIVER_ACCEPTED'],
        });
        await run(await ride(p.id, { status: 'failed' }), p.id, 'NO_ELIGIBLE_DRIVER');

        expect(outbox).toHaveLength(1);
        expect(outbox[0].subject).toContain('couldn’t connect you');
        const row = (await dispatches()).find((d) => d.channel === 'email')!;
        expect(row.outcomeReason).toBe('NO_ELIGIBLE_DRIVER');
    });

    it('4. NO_DRIVER_ACCEPTED produces the same message, recorded under its own code', async () => {
        const p = await passenger();
        await trigger({
            key: 'ride_not_fulfilled', templateKey: 'ride_not_fulfilled_apology',
            triggerCodes: ['NO_ELIGIBLE_DRIVER', 'NO_DRIVER_ACCEPTED'],
        });
        await run(await ride(p.id, { status: 'failed' }), p.id, 'NO_DRIVER_ACCEPTED');

        expect(outbox).toHaveLength(1);
        // The operational distinction survives even though the wording does not.
        const row = (await dispatches()).find((d) => d.channel === 'email')!;
        expect(row.outcomeReason).toBe('NO_DRIVER_ACCEPTED');
    });

    it('4b. the apology never claims there were no drivers nearby', async () => {
        const p = await passenger();
        await trigger({
            key: 'ride_not_fulfilled', templateKey: 'ride_not_fulfilled_apology',
            triggerCodes: ['NO_DRIVER_ACCEPTED'],
        });
        await run(await ride(p.id, { status: 'failed' }), p.id, 'NO_DRIVER_ACCEPTED');

        // That sentence would be a lie for NO_DRIVER_ACCEPTED: drivers were
        // there, were offered the trip, and did not take it.
        expect(outbox[0].text.toLowerCase()).not.toContain('no drivers');
        expect(outbox[0].text.toLowerCase()).not.toContain('near you');
        expect(outbox[0].text).toContain('weren’t able to connect you');
    });

    it('5. a passenger cancellation sends nothing', async () => {
        const p = await passenger();
        await trigger({
            key: 'ride_not_fulfilled', templateKey: 'ride_not_fulfilled_apology',
            triggerCodes: ['NO_ELIGIBLE_DRIVER', 'NO_DRIVER_ACCEPTED'],
        });
        await run(await ride(p.id, { status: 'canceled' }), p.id, 'PASSENGER_CANCELLED');

        expect(outbox).toHaveLength(0);
        expect(await dispatches()).toHaveLength(0);
    });

    it('6. a technical failure sends nothing — we do not blame supply for our own fault', async () => {
        const p = await passenger();
        await trigger({
            key: 'ride_not_fulfilled', templateKey: 'ride_not_fulfilled_apology',
            triggerCodes: ['NO_ELIGIBLE_DRIVER', 'NO_DRIVER_ACCEPTED'],
        });
        await run(await ride(p.id, { status: 'failed' }), p.id, 'TECHNICAL_FAILURE');

        expect(outbox).toHaveLength(0);
        expect(await dispatches()).toHaveLength(0);
    });

    it('7. a voided training ride sends nothing', async () => {
        const p = await passenger();
        await trigger();
        const r = await ride(p.id, { voided: true, voidedReason: 'Training/demo ride' } as any);

        const [outcome] = await Lifecycle.handleRideEvent(event(r, p.id, 'COMPLETED') as any);
        await Lifecycle.sendDue(100);

        expect(outcome.skipped).toBe('ride_voided');
        expect(outbox).toHaveLength(0);
    });

    // ══ 8–10. Consent ═══════════════════════════════════════════════════

    it('8. a passenger opted out of marketing receives no marketing message', async () => {
        const p = await passenger();
        await consent(p.id, { marketing: false, marketingEmail: false, marketingPush: false });
        await trigger({
            key: 'inactive_passenger', consentClass: ConsentClass.MARKETING,
            templateKey: 'reactivation', triggerCodes: ['COMPLETED'],
        });
        await run(await ride(p.id), p.id, 'COMPLETED');

        expect(outbox).toHaveLength(0);
        const rows = await dispatches();
        expect(rows.every((r) => r.status === DispatchStatus.SKIPPED)).toBe(true);
        expect(rows.map((r) => r.reason)).toContain('no_consent');
    });

    it('9. that same passenger still receives a genuine service message', async () => {
        const p = await passenger();
        await consent(p.id, { marketing: false, marketingEmail: false, marketingPush: false });
        await trigger();                      // service class
        await run(await ride(p.id), p.id, 'COMPLETED');

        expect(outbox).toHaveLength(1);
        expect(pushCalls).toHaveLength(1);
    });

    it('9b. a passenger who was never asked gets service mail but no marketing', async () => {
        const p = await passenger();          // no preference row at all
        await trigger();
        await run(await ride(p.id), p.id, 'COMPLETED');
        expect(outbox).toHaveLength(1);

        outbox = [];
        await ds.query(`DELETE FROM ${SCHEMA}.communication_trigger`);
        await trigger({
            key: 'first_ride_reminder', consentClass: ConsentClass.MARKETING,
            templateKey: 'welcome', triggerCodes: ['COMPLETED'],
        });
        await run(await ride(p.id), p.id, 'COMPLETED');
        expect(outbox).toHaveLength(0);
    });

    it('10. a suppressed address is never attempted, even for a service message', async () => {
        const p = await passenger();
        await suppress(p.email);
        await trigger();
        await run(await ride(p.id), p.id, 'COMPLETED');

        expect(outbox).toHaveLength(0);            // email refused
        expect(pushCalls).toHaveLength(1);         // push unaffected
        const email = (await dispatches()).find((d) => d.channel === 'email')!;
        expect(email.status).toBe(DispatchStatus.SKIPPED);
        expect(email.reason).toBe('suppressed');
    });

    // ══ 11–12. Push edge cases ══════════════════════════════════════════

    it('11. a passenger with no usable push token is recorded, not failed', async () => {
        const p = await passenger();
        pushBehaviour = 'no_tokens';
        await trigger();
        await run(await ride(p.id), p.id, 'COMPLETED');

        const push = (await dispatches()).find((d) => d.channel === 'push')!;
        // Skipped, not failed: somebody we could never reach must not drag the
        // delivery rate down as though the send went wrong.
        expect(push.status).toBe(DispatchStatus.SKIPPED);
        expect(push.reason).toBe('no_active_tokens');
    });

    it('12. several devices for one passenger still produce one dispatch row', async () => {
        const p = await passenger();
        const tokens = ds.getRepository(DeviceToken);
        for (const t of ['tok-a', 'tok-b', 'tok-a']) {
            await tokens.save(tokens.create({
                userId: p.id, role: UserRole.PASSENGER, token: t,
                platform: 'android', isActive: true,
            } as any)).catch(() => undefined);
        }
        await trigger();
        await run(await ride(p.id), p.id, 'COMPLETED');

        expect((await dispatches()).filter((d) => d.channel === 'push')).toHaveLength(1);
        expect(pushCalls).toHaveLength(1);
    });

    // ══ Cooldown and cap ════════════════════════════════════════════════

    it('repeated requests inside the cooldown produce one apology, not five', async () => {
        const p = await passenger();
        await trigger({
            key: 'ride_not_fulfilled', templateKey: 'ride_not_fulfilled_apology',
            triggerCodes: ['NO_ELIGIBLE_DRIVER'], cooldownMinutes: 360,
        });

        for (let i = 0; i < 5; i++) {
            await run(await ride(p.id, { status: 'failed' }), p.id, 'NO_ELIGIBLE_DRIVER');
        }

        expect(outbox).toHaveLength(1);
        expect(pushCalls).toHaveLength(1);
    });

    it('the frequency cap stops the fourth message in a window', async () => {
        const p = await passenger();
        await trigger({ channels: ['email'], frequencyCap: 2, frequencyWindowDays: 30 });
        for (let i = 0; i < 4; i++) {
            await run(await ride(p.id), p.id, 'COMPLETED');
        }
        expect(outbox).toHaveLength(2);
    });

    // ══ 21. Test-mode containment ═══════════════════════════════════════

    it('21. TEST mode reaches only the allow-list, and creates no rows for anyone else', async () => {
        const inside = await passenger();
        const outside = await passenger();
        const subjects = ds.getRepository(CommunicationTestSubject);
        await subjects.save(subjects.create({ userId: inside.id, scope: 'TEST' } as any));

        await trigger({ mode: AutomationMode.TEST });

        await run(await ride(inside.id), inside.id, 'COMPLETED');
        await run(await ride(outside.id), outside.id, 'COMPLETED');

        expect(outbox).toHaveLength(1);
        expect(outbox[0].to).toBe(inside.email);

        // The containment is that no work was ever created for the outsider,
        // not that it was filtered later.
        const rows = await dispatches();
        expect(rows.every((r) => r.userId === inside.id)).toBe(true);
    });

    it('21b. an automation disabled entirely reaches nobody', async () => {
        const p = await passenger();
        await trigger({ enabled: false });
        await run(await ride(p.id), p.id, 'COMPLETED');
        expect(outbox).toHaveLength(0);
        expect(await dispatches()).toHaveLength(0);
    });

    // ══ 26. Isolation from the ride lifecycle ═══════════════════════════

    it('26. a provider that throws cannot break the caller', async () => {
        const p = await passenger();
        providerBehaviour = 'throw';
        await trigger({ channels: ['email'] });

        await expect(run(await ride(p.id), p.id, 'COMPLETED')).resolves.not.toThrow();

        const row = (await dispatches())[0];
        expect(row.attempts).toBe(1);
        expect(row.status).toBe(DispatchStatus.QUEUED);   // will retry
    });

    it('26b. publishing an event never throws, even with a handler that does', async () => {
        const { publishCommunicationEvent, onCommunicationEvent, resetCommunicationHandlers } =
            require('../../src/services/communication_events');
        resetCommunicationHandlers();
        onCommunicationEvent(() => { throw new Error('handler exploded'); });
        onCommunicationEvent(async () => { throw new Error('async handler exploded'); });

        expect(() => publishCommunicationEvent({
            type: 'ride.completed', rideId: 'R1', passengerId: 'P1',
            outcomeReason: 'COMPLETED', occurredAt: new Date().toISOString(),
        })).not.toThrow();

        // Let the deferred handlers run; an unhandled rejection here would
        // terminate the process under current Node.
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setTimeout(r, 20));
        resetCommunicationHandlers();
    });

    it('a permanent provider rejection is not retried forever', async () => {
        const p = await passenger();
        providerBehaviour = 'fail';
        await trigger({ channels: ['email'] });
        await run(await ride(p.id), p.id, 'COMPLETED');

        const row = (await dispatches())[0];
        expect(row.status).toBe(DispatchStatus.FAILED);
    });

    // ══ Step 7: failure paths. None may disturb a ride. ═════════════════

    it('Firebase being unavailable does not lose the message or break anything', async () => {
        const p = await passenger();
        (Notifications.sendToUser as jest.Mock).mockImplementation(async () => {
            throw new Error('Firebase unavailable');
        });
        await trigger({ channels: ['push'] });

        await expect(run(await ride(p.id), p.id, 'COMPLETED')).resolves.not.toThrow();

        const row = (await dispatches())[0];
        expect(row.attempts).toBe(1);
        expect(row.status).toBe(DispatchStatus.QUEUED);   // retried, not dropped
    });

    it('a passenger with an unusable email is skipped on email and still reached on push', async () => {
        // `user.email` is NOT NULL, so the reachable case is a malformed
        // address rather than a missing one.
        const p = await passenger({ email: 'not-an-address' } as any);
        await trigger();
        await run(await ride(p.id), p.id, 'COMPLETED');

        const rows = await dispatches();
        expect(rows.find((r) => r.channel === 'email')).toMatchObject({
            status: DispatchStatus.SKIPPED, reason: 'no_email',
        });
        expect(rows.find((r) => r.channel === 'push')).toMatchObject({ status: DispatchStatus.SENT });
    });

    it('draining the queue twice does not deliver twice', async () => {
        const p = await passenger();
        await trigger({ channels: ['email'] });
        await Lifecycle.handleRideEvent(event(await ride(p.id), p.id, 'COMPLETED') as any);

        await Lifecycle.sendDue(100);
        await Lifecycle.sendDue(100);   // a second worker, or the same one again

        expect(outbox).toHaveLength(1);
    });

    it('two workers draining concurrently do not deliver twice', async () => {
        const p = await passenger();
        await trigger({ channels: ['email'] });
        await Lifecycle.handleRideEvent(event(await ride(p.id), p.id, 'COMPLETED') as any);

        await Promise.all([Lifecycle.sendDue(100), Lifecycle.sendDue(100)]);

        expect(outbox).toHaveLength(1);
    });

    /*
     * The one that matters most. Every failure above is a lost thank-you;
     * this is whether communications can take down a ride.
     */
    it('a ride completes normally with every communications dependency broken', async () => {
        const {
            publishCommunicationEvent, onCommunicationEvent, resetCommunicationHandlers,
        } = require('../../src/services/communication_events');

        const p = await passenger();
        providerBehaviour = 'throw';
        (Notifications.sendToUser as jest.Mock).mockImplementation(async () => {
            throw new Error('Firebase unavailable');
        });
        await trigger();
        const rideId = await ride(p.id, { status: 'accepted' } as any);

        resetCommunicationHandlers();
        onCommunicationEvent((e: any) => Lifecycle.handleRideEvent(e));

        // Stand in for the ride-completion write that socket_handler performs,
        // with the publish immediately after it exactly as in production.
        const completeTheRide = async () => {
            await ds.getRepository(Ride).update(rideId, {
                status: 'completed', completedAt: new Date(), outcomeReason: 'COMPLETED',
            } as any);
            publishCommunicationEvent({
                type: 'ride.completed', rideId, passengerId: p.id,
                outcomeReason: 'COMPLETED', occurredAt: new Date().toISOString(),
            });
        };

        await expect(completeTheRide()).resolves.not.toThrow();

        // The ride is completed and stays completed.
        const after = await ds.getRepository(Ride).findOneBy({ rideId });
        expect(after!.status).toBe('completed');
        expect(after!.completedAt).toBeTruthy();

        // Give the deferred handlers time to run and fail on their own.
        await new Promise((r) => setTimeout(r, 60));
        await expect(Lifecycle.sendDue(100)).resolves.toBeDefined();

        const stillCompleted = await ds.getRepository(Ride).findOneBy({ rideId });
        expect(stillCompleted!.status).toBe('completed');

        resetCommunicationHandlers();
    });

    // ══ Audience eligibility ════════════════════════════════════════════

    it('the channel breakdown runs against real column types and separates the reasons', async () => {
        // This exists because the first version of the query compared a uuid
        // column to text and failed outright — a 500 on a screen that had
        // worked, caught only by opening it.
        const { AudienceService } = require('../../src/services/audience_service');

        const reachable = await passenger();
        await consent(reachable.id);
        const tokens = ds.getRepository(DeviceToken);
        await tokens.save(tokens.create({
            userId: reachable.id, role: UserRole.PASSENGER, token: 'tok-1',
            platform: 'android', isActive: true,
        } as any));

        const noConsent = await passenger();
        const bounced = await passenger();
        await consent(bounced.id);
        await suppress(bounced.email);

        const ids = [reachable.id, noConsent.id, bounced.id];
        const b = await AudienceService.channelBreakdown(ids);

        expect(b.total).toBe(3);
        expect(b.eligibleEmail).toBe(1);          // only the consenting, unsuppressed one
        expect(b.eligiblePush).toBe(1);           // only the one with a live token
        expect(b.eligibleSms).toBe(0);            // nobody consented to SMS
        expect(b.suppressed).toBe(1);
        expect(b.noConsent).toBe(1);
        expect(b.noReachableChannel).toBe(2);
    });

    it('an empty audience does not error', async () => {
        const { AudienceService } = require('../../src/services/audience_service');
        await expect(AudienceService.channelBreakdown([])).resolves.toMatchObject({ total: 0 });
    });

    // ══ 13–25. Campaigns ════════════════════════════════════════════════

    async function campaign(over: Partial<CommunicationCampaign> = {}): Promise<CommunicationCampaign> {
        const repo = ds.getRepository(CommunicationCampaign);
        return repo.save(repo.create({
            name: 'Weekend Ride Offer', status: CampaignStatus.SCHEDULED,
            createdByStaffId: 'staff-1', approvedByStaffId: 'staff-2',
            approvedAt: new Date(), scheduledAt: new Date(Date.now() - 60_000),
            audienceDefinition: {}, mode: 'PRODUCTION', ...over,
        } as any));
    }

    it('24. the scheduler consumes scheduledAt and releases the campaign', async () => {
        const c = await campaign();
        await Worker.tick();
        const after = await ds.getRepository(CommunicationCampaign).findOneBy({ id: c.id });

        // A campaign whose audience resolves to nobody legitimately runs
        // SCHEDULED → SENDING → COMPLETED inside one tick; what matters is that
        // scheduledAt was consumed and the send lifecycle actually started.
        expect(after!.status).not.toBe(CampaignStatus.SCHEDULED);
        expect([CampaignStatus.SENDING, CampaignStatus.COMPLETED]).toContain(after!.status);
        expect(after!.sendStartedAt).toBeTruthy();
    });

    it('13. a campaign scheduled in the future is left alone', async () => {
        const c = await campaign({ scheduledAt: new Date(Date.now() + 3_600_000) });
        await Worker.tick();
        const after = await ds.getRepository(CommunicationCampaign).findOneBy({ id: c.id });
        expect(after!.status).toBe(CampaignStatus.SCHEDULED);
    });

    it('22. a campaign that was never approved cannot be released', async () => {
        const c = await campaign({ approvedAt: null, approvedByStaffId: null } as any);
        await Worker.tick();
        const after = await ds.getRepository(CommunicationCampaign).findOneBy({ id: c.id });
        expect(after!.status).toBe(CampaignStatus.SCHEDULED);
    });

    it('16. a campaign cancelled before its time never sends', async () => {
        const c = await campaign({ status: CampaignStatus.CANCELLED });
        await Worker.tick();
        const after = await ds.getRepository(CommunicationCampaign).findOneBy({ id: c.id });
        expect(after!.status).toBe(CampaignStatus.CANCELLED);
        expect(outbox).toHaveLength(0);
    });

    it('17. a paused campaign does not progress', async () => {
        const c = await campaign({ status: CampaignStatus.PAUSED });
        await Worker.tick();
        const after = await ds.getRepository(CommunicationCampaign).findOneBy({ id: c.id });
        expect(after!.status).toBe(CampaignStatus.PAUSED);
        expect(outbox).toHaveLength(0);
    });

    it('15. two workers racing the same due campaign release it once', async () => {
        const c = await campaign();
        await Promise.all([Worker.tick(), Worker.tick(), Worker.tick()]);

        const after = await ds.getRepository(CommunicationCampaign).findOneBy({ id: c.id });
        expect(after!.status).not.toBe(CampaignStatus.SCHEDULED);
        // Released exactly once: one sendStartedAt, and no recipient was
        // materialised more than once by the three concurrent workers.
        expect(after!.sendStartedAt).toBeTruthy();
        const recips = await ds.getRepository(EmailCampaignRecipient)
            .count({ where: { campaignId: c.id } });
        expect(recips).toBe(0);
        expect(outbox).toHaveLength(0);
    });

    it('25. the marketing push queue is actually drained', async () => {
        const jobs = ds.getRepository(MarketingPushJob);
        const before = await jobs.count();
        const result = await Worker.tick();
        // The assertion that matters is that runBatch is reached at all: before
        // this worker existed, nothing in the codebase ever called it.
        expect(result).toHaveProperty('push');
        expect(await jobs.count()).toBe(before);
    });

    it('18. the email kill switch stops campaign sending', async () => {
        process.env.MARKETING_EMAIL_SEND_ENABLED = 'false';
        try {
            await campaign();
            await Worker.tick();
            await Worker.tick();
            expect(outbox).toHaveLength(0);
        } finally {
            process.env.MARKETING_EMAIL_SEND_ENABLED = 'true';
        }
    });

    it('20. a service message still goes out while marketing channels are off', async () => {
        process.env.MARKETING_EMAIL_SEND_ENABLED = 'false';
        process.env.MARKETING_PUSH_SEND_ENABLED = 'false';
        try {
            const p = await passenger();
            await trigger();                       // service class
            await run(await ride(p.id), p.id, 'COMPLETED');
            expect(outbox).toHaveLength(1);
        } finally {
            process.env.MARKETING_EMAIL_SEND_ENABLED = 'true';
            process.env.MARKETING_PUSH_SEND_ENABLED = 'true';
        }
    });

    it('19. marketing is refused while the switch is off, service is not', async () => {
        process.env.MARKETING_EMAIL_SEND_ENABLED = 'false';
        try {
            const p = await passenger();
            await consent(p.id);
            await trigger({
                key: 'inactive_passenger', consentClass: ConsentClass.MARKETING,
                templateKey: 'reactivation', channels: ['email'],
            });
            await run(await ride(p.id), p.id, 'COMPLETED');

            expect(outbox).toHaveLength(0);
            const row = (await dispatches())[0];
            expect(row.reason).toBe('channel_disabled');
        } finally {
            process.env.MARKETING_EMAIL_SEND_ENABLED = 'true';
        }
    });

    // ══ 14. Restart safety ══════════════════════════════════════════════

    it('14. a restart mid-send resumes from the rows still queued', async () => {
        const p = await passenger();
        await trigger({ channels: ['email'], delayMinutes: 0 });
        await Lifecycle.handleRideEvent(event(await ride(p.id), p.id, 'COMPLETED') as any);

        // Simulate the process dying before delivery: the claim row survives.
        const queued = await dispatches();
        expect(queued).toHaveLength(1);
        expect(queued[0].status).toBe(DispatchStatus.QUEUED);

        // A fresh worker picks it up. Nothing was held in memory.
        await Lifecycle.sendDue(100);
        expect(outbox).toHaveLength(1);
    });

    // ══ History ═════════════════════════════════════════════════════════

    it('records both what was sent and what was deliberately skipped', async () => {
        const p = await passenger();
        await suppress(p.email);
        await trigger();
        await run(await ride(p.id), p.id, 'COMPLETED');

        const history = await Lifecycle.historyFor(p.id);
        expect(history).toHaveLength(2);
        expect(history.find((h: any) => h.channel === 'email')).toMatchObject({
            status: 'skipped', reason: 'suppressed',
        });
        expect(history.find((h: any) => h.channel === 'push')).toMatchObject({ status: 'sent' });
    });
});
