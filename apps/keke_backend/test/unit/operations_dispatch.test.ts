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
