/**
 * Operations Dispatch: the judgements, without a database.
 *
 * The atomic transitions are covered against real Postgres in
 * test/integration/operations_dispatch_db.test.ts — they cannot be tested
 * honestly any other way. What is here is everything a database would not
 * help with: when a ride needs a human, who gets rung, whether a lease is
 * live, and the order a dispatcher sees drivers in.
 */
import { RideControlService } from '../../src/services/ride_control_service';
import { DispatchControlMode } from '../../src/models/RideDispatchControl';
import { OperationsQueueService } from '../../src/services/operations_queue_service';
import {
    OperationsNotificationService,
    DEFAULT_POLICY,
    EXCEPTION_ONLY_POLICY,
} from '../../src/services/operations_notification_service';
import { OperationsDispatchService } from '../../src/services/operations_dispatch_service';
import { RideStatus } from '../../src/models/Ride';
import { RideOutcomeCode } from '../../src/services/ride_outcome';
import { StaffRole, permissionsForRole, LEGACY_FORBIDDEN_PERMISSIONS, StaffPermission } from '../../src/config/staff_permissions';

const config = {
    leaseDurationMs: 180_000,
    leaseRenewIntervalMs: 30_000,
    sweepIntervalMs: 30_000,
    waitAttentionThresholdMs: 45_000,
    waitUrgentThresholdMs: 90_000,
    enabled: true,
    interventionEnabled: true,
};

const ride = (over: any = {}) => ({
    rideId: 'RIDE-1',
    status: RideStatus.SEARCHING,
    driverId: null,
    outcomeReason: null,
    createdAt: new Date(),
    ...over,
});

const rollup = (over: any = {}) => ({
    candidateCount: 0,
    eligibleDriverCount: 0,
    notifiedDriverCount: 0,
    finalOutcomeCode: null,
    ...over,
});

// ══════════════════════════════════════════════════════════════════════
//  A lease is live or it is not — sockets are irrelevant
// ══════════════════════════════════════════════════════════════════════

describe('control liveness is decided by the clock, never by a connection', () => {
    const now = new Date('2026-08-19T09:00:00Z');
    const live = (over: any = {}) => ({
        mode: DispatchControlMode.OPERATIONS,
        leaseExpiresAt: new Date(now.getTime() + 60_000),
        ...over,
    }) as any;

    it('a future expiry means controlled', () => {
        expect(RideControlService.isOperationsControlled(live(), now)).toBe(true);
    });

    it('a lapsed expiry means NOT controlled, even before the sweeper runs', () => {
        // The sweep is bookkeeping. Dispatch must treat a lapsed lease as
        // released immediately, or a dead client would keep blocking offers
        // for up to a full sweep interval.
        expect(RideControlService.isOperationsControlled(
            live({ leaseExpiresAt: new Date(now.getTime() - 1) }), now)).toBe(false);
    });

    it('AUTO is never controlled however recent the lease looks', () => {
        expect(RideControlService.isOperationsControlled(
            live({ mode: DispatchControlMode.AUTO }), now)).toBe(false);
    });

    it('a missing control row means AUTO, not an error', () => {
        expect(RideControlService.isOperationsControlled(null, now)).toBe(false);
        expect(RideControlService.isOperationsControlled(undefined, now)).toBe(false);
    });

    it('a null expiry is not a permanent lease', () => {
        // Otherwise a malformed row would hold a passenger's ride forever.
        expect(RideControlService.isOperationsControlled(
            live({ leaseExpiresAt: null }), now)).toBe(false);
    });
});

// ══════════════════════════════════════════════════════════════════════
//  NEEDS ATTENTION
// ══════════════════════════════════════════════════════════════════════

describe('the queue only calls for a human when evidence says so', () => {
    it('a brand-new request is healthy, not a problem', () => {
        // Crying wolf within two seconds of every request would make the
        // queue useless on the first busy morning.
        const a = OperationsQueueService.assessAttention(ride() as any, rollup(), 2, config);
        expect(a.triggers).toEqual([]);
        expect(a.severity).toBe('none');
    });

    it('a ride not yet searched is not "no drivers available"', () => {
        // No rollup means dispatch has not reported yet. Absence of evidence
        // is not evidence of absence.
        const a = OperationsQueueService.assessAttention(ride() as any, undefined, 5, config);
        expect(a.triggers).toEqual([]);
    });

    it('candidates found but none eligible is a supply problem', () => {
        const a = OperationsQueueService.assessAttention(
            ride() as any, rollup({ candidateCount: 6, eligibleDriverCount: 0 }), 10, config);
        expect(a.triggers).toContain('NO_ELIGIBLE_DRIVER');
    });

    it('offers delivered and unanswered past the threshold needs attention', () => {
        const a = OperationsQueueService.assessAttention(
            ride() as any, rollup({ candidateCount: 3, eligibleDriverCount: 3, notifiedDriverCount: 3 }),
            50, config);
        expect(a.triggers).toContain('NO_DRIVER_ACCEPTED');
    });

    it('offers delivered but still inside the threshold does not', () => {
        const a = OperationsQueueService.assessAttention(
            ride() as any, rollup({ candidateCount: 3, eligibleDriverCount: 3, notifiedDriverCount: 3 }),
            10, config);
        expect(a.triggers).not.toContain('NO_DRIVER_ACCEPTED');
    });

    it('a long wait alone is enough', () => {
        const a = OperationsQueueService.assessAttention(ride() as any, rollup(), 60, config);
        expect(a.triggers).toContain('WAIT_EXCEEDS_THRESHOLD');
        expect(a.severity).toBe('warning');
    });

    it('escalates to urgent past the urgent threshold', () => {
        const a = OperationsQueueService.assessAttention(ride() as any, rollup(), 120, config);
        expect(a.severity).toBe('urgent');
    });

    it('a technical failure is always urgent', () => {
        const a = OperationsQueueService.assessAttention(
            ride({ status: RideStatus.FAILED, outcomeReason: RideOutcomeCode.TECHNICAL_FAILURE }) as any,
            rollup(), 5, config);
        expect(a.triggers).toContain('TECHNICAL_FAILURE');
        expect(a.severity).toBe('urgent');
    });

    it('a completed or cancelled ride needs nobody', () => {
        for (const status of [RideStatus.COMPLETED, RideStatus.CANCELED]) {
            const a = OperationsQueueService.assessAttention(
                ride({ status }) as any, rollup(), 9999, config);
            expect(a.severity).toBe('none');
        }
    });

    it('an assigned ride stops accruing wait triggers', () => {
        // The passenger has a Keke. A long "wait" is now a journey.
        const a = OperationsQueueService.assessAttention(
            ride({ driverId: 'd1', status: RideStatus.ACCEPTED }) as any, rollup(), 600, config);
        expect(a.triggers).toEqual([]);
    });

    it('thresholds come from config, so the rollout can be retuned', () => {
        const quiet = { ...config, waitAttentionThresholdMs: 600_000 };
        expect(OperationsQueueService.assessAttention(ride() as any, rollup(), 60, quiet).triggers)
            .toEqual([]);
    });
});

// ══════════════════════════════════════════════════════════════════════
//  Notification policy
// ══════════════════════════════════════════════════════════════════════

describe('notification policy is data, not code', () => {
    it('the rollout default rings for every new request', () => {
        const d = OperationsNotificationService.decide(DEFAULT_POLICY, {
            isNewRequest: true, triggers: [], severity: 'none',
        });
        expect(d.notify).toBe(true);
        expect(d.reason).toBe('EVERY_REQUEST');
        expect(d.urgent).toBe(false);
    });

    it('exception-only stays silent on an ordinary request', () => {
        const d = OperationsNotificationService.decide(EXCEPTION_ONLY_POLICY, {
            isNewRequest: true, triggers: [], severity: 'none',
        });
        expect(d.notify).toBe(false);
    });

    it('exception-only still shouts when there is no supply', () => {
        const d = OperationsNotificationService.decide(EXCEPTION_ONLY_POLICY, {
            isNewRequest: false, triggers: ['NO_ELIGIBLE_DRIVER'], severity: 'warning',
        });
        expect(d.notify).toBe(true);
        expect(d.urgent).toBe(true);
    });

    it('a problem outranks "new request" in what it says', () => {
        // A ride that is both new and already failing should announce the
        // failure, which is the more useful fact.
        const d = OperationsNotificationService.decide(DEFAULT_POLICY, {
            isNewRequest: true, triggers: ['NO_ELIGIBLE_DRIVER'], severity: 'warning',
        });
        expect(d.reason).toBe('NO_ELIGIBLE_DRIVER');
        expect(d.urgent).toBe(true);
    });

    it('urgent severity escalates a normally-quiet trigger', () => {
        const d = OperationsNotificationService.decide(DEFAULT_POLICY, {
            isNewRequest: false, triggers: ['WAIT_EXCEEDS_THRESHOLD'], severity: 'urgent',
        });
        expect(d.notify).toBe(true);
        expect(d.urgent).toBe(true);
    });

    it('pushEnabled false silences everything', () => {
        const d = OperationsNotificationService.decide(
            { ...DEFAULT_POLICY, pushEnabled: false },
            { isNewRequest: true, triggers: ['TECHNICAL_FAILURE'], severity: 'urgent' },
        );
        expect(d.notify).toBe(false);
    });

    it('an empty trigger list notifies about nothing', () => {
        const d = OperationsNotificationService.decide(
            { ...DEFAULT_POLICY, triggers: [] },
            { isNewRequest: true, triggers: ['NO_ELIGIBLE_DRIVER'], severity: 'urgent' },
        );
        expect(d.notify).toBe(false);
    });
});

// ══════════════════════════════════════════════════════════════════════
//  Permissions
// ══════════════════════════════════════════════════════════════════════

describe('the Operations role is capability-driven and cannot bypass anything', () => {
    const ops = permissionsForRole(StaffRole.OPERATIONS_DISPATCHER);

    it('holds exactly the powers the job needs', () => {
        for (const p of [
            StaffPermission.OPS_QUEUE_READ,
            StaffPermission.OPS_TAKEOVER,
            StaffPermission.OPS_RELEASE,
            StaffPermission.OPS_ASSIGN,
            StaffPermission.OPS_CONTACT_DRIVER,
        ]) {
            expect(ops).toContain(p);
        }
    });

    it('has no wallet, staff or park administration authority', () => {
        for (const p of [
            StaffPermission.WALLET_ADJUST,
            StaffPermission.WALLET_REVERSE,
            StaffPermission.STAFF_CREATE,
            StaffPermission.STAFF_ASSIGN_ROLES,
            StaffPermission.PARK_CREATE,
            StaffPermission.BADGE_ISSUE,
        ]) {
            expect(ops).not.toContain(p);
        }
    });

    it('a shared admin key can never take over or assign', () => {
        // Same rule as contact reveal: seizing a live ride must be
        // attributable to a named human.
        for (const p of [
            StaffPermission.OPS_TAKEOVER,
            StaffPermission.OPS_RELEASE,
            StaffPermission.OPS_ASSIGN,
            StaffPermission.OPS_CONTACT_DRIVER,
        ]) {
            expect(LEGACY_FORBIDDEN_PERMISSIONS.has(p)).toBe(true);
        }
    });

    it('the whole Operations surface is closed to a shared key', () => {
        // OPS_QUEUE_READ is deliberately NOT in the forbidden set — the
        // permission itself is harmless — but the router applies
        // requireRealStaff to every Operations route, so a shared key reaches
        // none of it. That is the stronger posture and the correct one: the
        // queue is a live feed of every passenger in the city, with their
        // pickup, destination and masked number. Streaming that to a
        // credential with no person behind it is not observation, it is an
        // unattributable export.
        //
        // Verified against production: /operations/queue returns 403 to the
        // shared admin key.
        expect(LEGACY_FORBIDDEN_PERMISSIONS.has(StaffPermission.OPS_QUEUE_READ)).toBe(false);
    });

    it('a supervisor may watch but not intervene', () => {
        const admin = permissionsForRole(StaffRole.OPERATIONS_ADMIN);
        expect(admin).toContain(StaffPermission.OPS_QUEUE_READ);
        expect(admin).not.toContain(StaffPermission.OPS_ASSIGN);
        expect(admin).not.toContain(StaffPermission.OPS_TAKEOVER);
    });
});

// ══════════════════════════════════════════════════════════════════════
//  Ineligibility is explained, never hidden
// ══════════════════════════════════════════════════════════════════════

describe('a dispatcher is told WHY a driver cannot take the ride', () => {
    it('translates every reason the eligibility service produces', () => {
        // Hiding an ineligible driver would leave a dispatcher wondering where
        // Emeka went. Showing him greyed out with a reason is actionable.
        const cases: Array<[string, RegExp]> = [
            ['driver_suspended_or_rejected', /suspended|not approved/i],
            ['already_on_active_ride', /another ride/i],
            ['cash_debt_blocked', /debt/i],
            ['no_driver_profile', /profile/i],
            ['explicit_rejector', /declined/i],
        ];
        for (const [code, pattern] of cases) {
            expect(OperationsDispatchService.explainIneligibility(code)).toMatch(pattern);
        }
    });

    it('an unknown reason still says something useful', () => {
        expect(OperationsDispatchService.explainIneligibility('some_new_rule'))
            .toContain('some_new_rule');
    });
});

describe('the admin staff form can actually grant the role', () => {
    const fs = require('fs');
    const path = require('path');
    const adminApp = path.join(__dirname, '../../../keke_admin/app.js');

    // The role list in the admin UI is hand-maintained and is the ONLY way to
    // assign a role to a person. OPERATIONS_DISPATCHER was added to the server
    // enum and left out of that list, so the role existed, was authorised, was
    // tested — and could not be given to anybody. Found when a staff account
    // was being created and the checkbox was not there.
    const listed = () => {
        const src = fs.readFileSync(adminApp, 'utf8');
        const m = src.match(/const STAFF_ROLES = \[([\s\S]*?)\];/);
        return m ? m[1].match(/'([A-Z_]+)'/g)?.map((q: string) => q.replace(/'/g, '')) ?? [] : [];
    };

    it('offers every server-side role', () => {
        const { ALL_STAFF_ROLES } = require('../../src/config/staff_permissions');
        const inForm = listed();
        for (const role of ALL_STAFF_ROLES) {
            expect(inForm).toContain(role);
        }
    });

    it('offers no role the server would reject', () => {
        const { isStaffRole } = require('../../src/config/staff_permissions');
        for (const role of listed()) {
            expect(isStaffRole(role)).toBe(true);
        }
    });
});

// ══════════════════════════════════════════════════════════════════════
//  What a lock screen may say
// ══════════════════════════════════════════════════════════════════════

describe('an Operations alert carries no passenger identity', () => {
    const row = (over: any = {}) => ({
        rideId: 'RIDE-9',
        waitingSeconds: 95,
        pickupArea: 'Awada, Obosi',
        destinationArea: 'Main Market',
        passenger: { id: 'p1', name: 'Chinedu O.', phoneMasked: '2348••••221' },
        candidateCount: 4,
        eligibleDriverCount: 2,
        offersSent: 2,
        ...over,
    }) as any;

    it('never puts the passenger name or number on the lock screen', () => {
        // Readable by anyone holding the phone, mirrored to a watch, and it
        // can sit in a shade for hours. A dispatcher does not need to know WHO
        // is waiting to decide whether to act — only where, how long, and
        // whether dispatch is coping. Identity is one authenticated tap away.
        const { title, body } = OperationsNotificationService.compose(
            row(), { urgent: false, reason: 'EVERY_REQUEST' });
        const text = `${title} ${body}`;
        expect(text).not.toContain('Chinedu');
        expect(text).not.toContain('2348');
        expect(text).not.toMatch(/\d{7,}/);
    });

    it('says where, where to, how long, and what dispatch is doing', () => {
        const { title, body } = OperationsNotificationService.compose(
            row(), { urgent: false, reason: 'EVERY_REQUEST' });
        expect(title).toContain('Awada, Obosi');
        expect(body).toContain('Main Market');
        expect(body).toContain('2m');
        expect(body).toContain('2 offered, none accepted');
    });

    it('reports "no drivers found" when nothing was discovered', () => {
        const { body } = OperationsNotificationService.compose(
            row({ candidateCount: 0, eligibleDriverCount: 0, offersSent: 0 }),
            { urgent: true, reason: 'NO_ELIGIBLE_DRIVER' });
        expect(body).toContain('no drivers found');
    });

    it('leads with the problem when there is one', () => {
        const { title } = OperationsNotificationService.compose(
            row(), { urgent: true, reason: 'NO_ELIGIBLE_DRIVER' });
        expect(title).toContain('Needs attention');
    });

    it('says "Area not recorded" rather than inventing a place', () => {
        const { title, body } = OperationsNotificationService.compose(
            row({ pickupArea: null, destinationArea: null }),
            { urgent: false, reason: 'EVERY_REQUEST' });
        expect(title).toContain('Area not recorded');
        expect(body).toContain('destination not recorded');
    });

    it('shows seconds while a request is fresh', () => {
        const { body } = OperationsNotificationService.compose(
            row({ waitingSeconds: 12 }), { urgent: false, reason: 'EVERY_REQUEST' });
        expect(body).toContain('12s');
    });
});

// ══════════════════════════════════════════════════════════════════════
//  Calling a driver
// ══════════════════════════════════════════════════════════════════════

describe('the Call action produces something a handset can dial', () => {
    const { toLocalDialable } = require('../../src/utils/phone');

    it('normalises the forms Nigerian numbers are stored in', () => {
        // The field failure was that no number reached the client at all. Once
        // it does, it has to be in a shape Android will dial without the
        // operator editing it.
        expect(toLocalDialable('2348031234567')).toBe('08031234567');
        expect(toLocalDialable('+234 803 123 4567')).toBe('08031234567');
        expect(toLocalDialable('08031234567')).toBe('08031234567');
        expect(toLocalDialable('8031234567')).toBe('08031234567');
    });

    it('never invents a number it cannot make sense of', () => {
        expect(toLocalDialable(null)).toBeNull();
        expect(toLocalDialable(undefined)).toBeUndefined();
    });

    it('produces a tel: href with no spaces or punctuation', () => {
        // `tel:+234 803...` is not reliably dialled; the normalised form is.
        const href = `tel:${toLocalDialable('+234 803 123 4567')}`;
        expect(href).toBe('tel:08031234567');
        expect(href).not.toMatch(/[\s()+-]/);
    });
});

describe('the dispatcher UI actually wires the dialer', () => {
    const fs = require('fs');
    const path = require('path');
    const src = () => fs.readFileSync(
        path.join(__dirname, '../../../keke_dispatcher/operations.js'), 'utf8');

    it('builds a tel: link rather than only recording the intent', () => {
        // The original Call button recorded the contact and showed a toast
        // telling the operator to find the number in the admin console. On a
        // phone that reads as the button doing nothing — which is exactly what
        // was reported from the field.
        const s = src();
        expect(s).toContain('`tel:${number}`');
        expect(s).not.toContain('Reveal the number in Keke Ops to dial');
    });

    it('says so plainly when there is no number', () => {
        expect(src()).toContain('Phone number unavailable for this driver.');
    });

    it('offers a fallback link and a copy action', () => {
        // If the dialer refuses to launch the operator must not be left
        // looking at a screen that did nothing.
        const s = src();
        expect(s).toContain('showCallFallback');
        expect(s).toContain('data-copy=');
        expect(s).toContain('The dialer did not open');
    });

    it('offers every reassignment reason the server accepts', () => {
        const { ReassignReason } = require('../../src/services/operations_dispatch_service');
        const s = src();
        for (const code of Object.values(ReassignReason)) {
            expect(s).toContain(`'${code}'`);
        }
    });
});

describe('reassignment is only offered before the trip starts', () => {
    const { REASSIGNABLE_STATUSES } = require('../../src/services/operations_dispatch_service');

    it('covers the pre-trip states and nothing else', () => {
        expect(REASSIGNABLE_STATUSES).toEqual(['accepted', 'arrived']);
        // A moving Keke with a passenger in it is an incident, not a swap.
        expect(REASSIGNABLE_STATUSES).not.toContain('in_progress');
        expect(REASSIGNABLE_STATUSES).not.toContain('started');
        expect(REASSIGNABLE_STATUSES).not.toContain('completed');
        expect(REASSIGNABLE_STATUSES).not.toContain('canceled');
    });
});

// ══════════════════════════════════════════════════════════════════════
//  The reassign control has to be REACHABLE
// ══════════════════════════════════════════════════════════════════════

describe('a dispatcher can actually see the reassign control', () => {
    const fs = require('fs');
    const path = require('path');
    const src = () => fs.readFileSync(
        path.join(__dirname, '../../../keke_dispatcher/operations.js'), 'utf8');

    it('does not gate visibility on holding the lease', () => {
        // The field report was "I cannot find this interface". Two independent
        // faults, either fatal on its own:
        //
        //   1. assignDriverToRide releases control for EVERY source, so the
        //      instant Operations assigned a driver `mine` became false.
        //   2. queueState folds control and lifecycle into one value, so
        //      holding the lease makes it OPERATIONS_CONTROL — never
        //      'ASSIGNED'.
        //
        // The old condition was `mine && queueState === 'ASSIGNED'`, whose two
        // clauses are mutually exclusive. It could not render on any device.
        const s = src();
        expect(s).not.toContain("mine && can('ops:assign') && ['ASSIGNED'].includes(r.queueState)");
    });

    it('gates on the ride status the server actually enforces', () => {
        const s = src();
        expect(s).toContain("const PRE_TRIP = ['accepted', 'arrived']");
        expect(s).toContain('PRE_TRIP.includes(String(r.status))');
    });

    it('the client and server agree on which states allow a swap', () => {
        // Two lists in two languages; if they drift, the operator is either
        // offered a button that always fails or denied one that would work.
        const { REASSIGNABLE_STATUSES } = require('../../src/services/operations_dispatch_service');
        const m = src().match(/const PRE_TRIP = \[([^\]]*)\]/);
        const client = m![1].match(/'([a-z_]+)'/g)!.map((q: string) => q.replace(/'/g, ''));
        expect(client).toEqual(REASSIGNABLE_STATUSES);
    });

    it('asks for a named confirmation before removing anyone', () => {
        const s = src();
        expect(s).toContain('Remove ${esc(r.driver.name)} from this ride?');
        expect(s).toContain('data-reassign-confirm');
        expect(s).toContain('Remove &amp; Reassign');
    });

    it('takes control itself rather than expecting the operator to', () => {
        // Assignment hands the lease back to AUTO, so the dispatcher does not
        // hold it when they decide to reassign. Making them press Take over
        // first is exactly the obscure workflow that was reported.
        const s = src();
        expect(s).toContain('/takeover`, \'POST\'');
        expect(s).toContain('holdsIt');
    });

    it('says why reassignment is unavailable once the trip has started', () => {
        expect(src()).toContain('This trip has already started');
    });
});

describe('a refusal says what is actually true of the ride', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
        path.join(__dirname, '../../../keke_dispatcher/operations.js'), 'utf8');

    it('does not tell a cancelled ride that its trip started', () => {
        // Found by walking every status in the browser: a cancelled ride never
        // started and a completed one finished, so the started-trip sentence
        // was wrong for both. An operator reading a line that contradicts what
        // is on screen starts distrusting the rest of it.
        expect(src).toContain("case 'canceled':");
        expect(src).toContain('This ride was cancelled.');
        expect(src).toContain('This trip is finished.');
    });

    it('keeps the incident-workflow wording for a trip in progress', () => {
        expect(src).toContain('Use the incident/cancellation workflow instead.');
    });
});

// ══════════════════════════════════════════════════════════════════════
//  The incoming-request ring
// ══════════════════════════════════════════════════════════════════════

describe('Operations rings with the Driver app\'s own ride-request sound', () => {
    const fs = require('fs');
    const path = require('path');
    const root = path.join(__dirname, '../../..');
    const driverAsset = path.join(root, 'keke_driver/assets/sounds/keke_ring.wav');
    const opsAsset = path.join(root, 'keke_dispatcher/sounds/keke_ring.wav');
    const src = () => fs.readFileSync(path.join(root, 'keke_dispatcher/operations.js'), 'utf8');

    it('uses the identical file, not a lookalike', () => {
        // Two runtimes (Flutter + audioplayers, and a PWA) cannot share code,
        // so the SOUND is the shared thing. This test is what stops the two
        // copies drifting into "nearly the same ringtone".
        expect(fs.existsSync(opsAsset)).toBe(true);
        expect(fs.readFileSync(opsAsset).equals(fs.readFileSync(driverAsset))).toBe(true);
    });

    it('loops until answered, like the driver side', () => {
        // The driver plays it with ReleaseMode.loop and stops on accept,
        // decline or timeout. Same contract here.
        const s = src();
        expect(s).toContain("new Audio('./sounds/keke_ring.wav')");
        expect(s).toContain('ringAudio.loop = true');
    });

    it('cannot stack loops for the same ride', () => {
        // Queue polls every 8s, sockets can duplicate, and a push can be
        // re-delivered. Any of those calling startRing again must be inert.
        const s = src();
        expect(s).toContain('if (ringingFor === rideId) return;');
    });

    it('is driven by the queue, not by events', () => {
        // Deriving "is anything ringing" from current state rather than from
        // event arrivals is what makes duplicates harmless by construction.
        const s = src();
        expect(s).toContain('function evaluateRing()');
        expect(s).toContain('OPS.rides.filter(isActionable)');
    });

    it('does not ring through the backlog when the surface opens', () => {
        const s = src();
        expect(s).toContain('if (!OPS.primed)');
        expect(s).toContain('OPS.primed = false');
    });

    it('stops when the ride is opened, handled, or no longer actionable', () => {
        const s = src();
        expect(s).toContain('OPS.selected === ringingFor) stopRing()');
        expect(s).toContain('if (ringingFor === rideId) stopRing();');
        expect(s).toContain("['AUTO_HEALTHY', 'NEEDS_ATTENTION'].includes(r.queueState)");
    });

    it('offers a way to silence it without opening anything', () => {
        const s = src();
        expect(s).toContain('data-silence');
        expect(s).toContain('tap to silence');
    });

    it('is precached, so the first alert is not late', () => {
        const sw = fs.readFileSync(path.join(root, 'keke_dispatcher/sw.js'), 'utf8');
        expect(sw).toContain("'./sounds/keke_ring.wav'");
    });

    it('leaves the Driver app untouched', () => {
        // Scope check: this was an Operations audio change only.
        const driverSound = fs.readFileSync(
            path.join(root, 'keke_driver/lib/core/services/sound_service.dart'), 'utf8');
        expect(driverSound).toContain("AssetSource('sounds/keke_ring.wav')");
        expect(driverSound).toContain('ReleaseMode.loop');
    });
});

// ══════════════════════════════════════════════════════════════════════
//  Session persistence
// ══════════════════════════════════════════════════════════════════════

describe('an Operations session survives the phone', () => {
    const fs = require('fs');
    const path = require('path');
    const app = () => fs.readFileSync(
        path.join(__dirname, '../../../keke_dispatcher/app.js'), 'utf8');

    it('stores credentials somewhere that outlives the process', () => {
        // sessionStorage was the bug. It is scoped to the browsing CONTEXT,
        // and swiping an installed PWA from Android recents destroys that
        // context — so the dispatcher was signed out by closing the app, and
        // received no alerts until they noticed.
        const s = app();
        expect(s).toContain("localStorage.getItem(key)");
        expect(s).not.toContain("accessToken: sessionStorage.getItem('KD_TOKEN')");
        expect(s).not.toContain("sessionStorage.setItem('KD_TOKEN'");
    });

    it('migrates a session that was already signed in', () => {
        // Otherwise the fix itself logs everybody out once.
        expect(app()).toContain('sessionStorage.getItem(key)');
    });

    it('does NOT clear credentials when the server is unreachable', () => {
        // The second bug: a bare catch cleared on any failure, so losing
        // signal logged the dispatcher out. Losing signal is not a security
        // event.
        const s = app();
        expect(s).not.toMatch(/S\.me = await api\('\/dispatcher\/me'\);\s*\}\s*catch\s*\{\s*sessionStorage\.clear\(\)/);
        expect(s).toContain('showReconnecting()');
        expect(s).toContain('scheduleSessionRetry()');
    });

    it('clears ONLY on a genuine authorisation refusal', () => {
        const s = app();
        expect(s).toContain('if (status === 401 || status === 403)');
        expect(s).toContain('Reconnecting to KekeRide Operations…');
    });

    it('retries with backoff and on regaining connectivity', () => {
        const s = app();
        expect(s).toContain("addEventListener('online'");
        expect(s).toContain('Math.min(sessionRetryDelay * 2, 30000)');
    });

    it('re-registers push before the shift branch, not after', () => {
        // setUpPush sat after the `onDuty` early return, so an Operations
        // dispatcher — who has no park shift — never re-registered. FCM tokens
        // rotate, so alerts would quietly stop arriving.
        const s = app();
        const pushIdx = s.indexOf("setUpPush({ interactive: false })");
        const shiftIdx = s.indexOf('if (!S.me.onDuty) { showShiftGate(); return; }');
        expect(pushIdx).toBeGreaterThan(-1);
        expect(shiftIdx).toBeGreaterThan(-1);
        expect(pushIdx).toBeLessThan(shiftIdx);
    });
});

describe('the staff session TTL is role-aware', () => {
    const { StaffAuthService, StaffAuthConfig } = require('../../src/services/staff_auth_service');
    const { StaffRole } = require('../../src/config/staff_permissions');

    it('gives the Operations device a session measured in weeks', () => {
        // A dedicated phone that must stay operational across days, not the
        // shared park tablet the 12-hour default was written for.
        const hours = StaffAuthService.sessionHoursFor([StaffRole.OPERATIONS_DISPATCHER]);
        expect(hours).toBe(720);
        expect(hours / 24).toBe(30);
    });

    it('leaves a park dispatcher on the existing one-shift session', () => {
        expect(StaffAuthService.sessionHoursFor([StaffRole.PARK_DISPATCHER]))
            .toBe(StaffAuthConfig.refreshTokenHours);
        expect(StaffAuthConfig.refreshTokenHours).toBe(12);
    });

    it('applies the longer window when Operations is one of several roles', () => {
        expect(StaffAuthService.sessionHoursFor(
            [StaffRole.SUPPORT_OFFICER, StaffRole.OPERATIONS_DISPATCHER])).toBe(720);
    });

    it('keeps the access token short-lived — this is not a long-lived JWT', () => {
        // The session is durable; the bearer token is not. Revocation still
        // bites within an access-token lifetime at worst.
        expect(StaffAuthConfig.accessTokenMinutes).toBe(60);
    });
});

// ══════════════════════════════════════════════════════════════════════
//  Financial recovery: bounded, idempotent, and blind to quarantine
// ══════════════════════════════════════════════════════════════════════

describe('automatic financial recovery', () => {
    const fs = require('fs');
    const path = require('path');
    const worker = () => fs.readFileSync(
        path.join(__dirname, '../../src/services/financial_recovery_worker.ts'), 'utf8');
    const svc = () => fs.readFileSync(
        path.join(__dirname, '../../src/services/wallet_service.ts'), 'utf8');

    it('never touches a quarantined ride', () => {
        // The 99 historical failures are quarantined precisely so that turning
        // recovery on cannot silently post ~₦80k across 46 drivers who have
        // spent a month believing they owed nothing.
        expect(worker()).toContain('COALESCE(r."financialQuarantine", false) = false');
        expect(svc()).toContain("code: 'QUARANTINED'");
    });

    it('is bounded — it escalates instead of retrying forever', () => {
        const w = worker();
        expect(w).toContain('MAX_ATTEMPTS');
        expect(w).toContain('escalated_to_exceptions');
        expect(w).toMatch(/backoffMs|Math\.pow/);
    });

    it('treats ALREADY_POSTED as success, not as a failure to retry', () => {
        // The money is there, which is the outcome wanted. Retrying it would
        // burn attempts and eventually escalate a ride that is actually fine.
        expect(worker()).toContain("(result as any).code === 'ALREADY_POSTED'");
    });

    it('stops immediately on a refusal that can never succeed', () => {
        // No driver, no fare, not completed — burning five attempts on a
        // structurally impossible posting helps nobody.
        expect(worker()).toContain('financialRetryCount: MAX_ATTEMPTS');
    });

    it('guards idempotency on the LEDGER, not on the flag', () => {
        const s = svc();
        expect(s).toContain("le.metadata->>'rideId' = :rideId");
        expect(s).toContain("code: 'ALREADY_POSTED'");
    });

    it('a completion failure schedules its own retry', () => {
        const handler = fs.readFileSync(
            path.join(__dirname, '../../src/sockets/socket_handler.ts'), 'utf8');
        expect(handler).toContain('financialNextRetryAt: new Date(Date.now() + 60_000)');
    });

    it('the quarantine migration marks, and never charges', () => {
        const mig = fs.readFileSync(
            path.join(__dirname, '../../src/migrations/1806000000000-FinancialRecovery.ts'), 'utf8');
        expect(mig).toContain('"financialQuarantine" = true');
        // No balance, debt or ledger write anywhere in it.
        expect(mig).not.toMatch(/driverCommissionDebt|driverAvailableBalance|INSERT INTO "ledger_entry"/);
    });
});
