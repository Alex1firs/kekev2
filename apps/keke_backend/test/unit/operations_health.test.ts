/**
 * Park health and alerts.
 *
 * A health colour is read at a glance and acted on without reading further, so
 * the two failure modes that matter are a red park shown green (somebody is
 * losing rides and nobody is told) and a healthy park shown red (the panel
 * trains people to ignore it). Both are covered here.
 *
 * The private methods are exercised directly: the surrounding `build()` reads
 * eight tables, and the decision being tested is pure.
 */

import { ParkOperationsCentreService } from '../../src/services/park_operations_centre_service';
import { ParkStatus } from '../../src/models/Park';

const svc = ParkOperationsCentreService as any;

/** A park where nothing is wrong. Each test breaks exactly one thing. */
function healthy(overrides: Partial<any> = {}) {
    return {
        parkId: 'park-1',
        name: 'Holy Trinity',
        code: 'HOLY',
        operationalStatus: 'open',
        parkStatus: ParkStatus.ACTIVE,
        withinOperatingHours: true,
        opensAt: '05:00',
        closesAt: '19:00',
        dispatchersOnShift: [{ staffUserId: 's1', name: 'Ada', shiftMinutes: 30, lastActivityMinutes: 2 }],
        driversOnline: 3,
        driversWaiting: 2,
        driversOnTrip: 1,
        driversPresent: 2,
        driversAssignable: 2,
        featurePhoneDrivers: 1,
        smartphoneDrivers: 2,
        activeRequests: 1,
        queueLength: 1,
        avgDispatchSeconds: 12,
        successfulDispatchPct: 95,
        failedDispatchPct: 5,
        gpsHealthy: 3,
        gpsStale: 0,
        pushAcceptedToday: 20,
        pushFailedToday: 0,
        pushFailureRatePct: 0,
        health: 'green',
        alerts: [],
        blockers: [],
        ...overrides,
    };
}

const base = (row: any) => ({ withinOperatingHours: row.withinOperatingHours, blockers: [] });

function evaluate(row: any) {
    const alerts = svc.alertsFor(row, base(row));
    return { alerts, health: svc.healthOf({ ...row, alerts }) };
}

const codes = (alerts: any[]) => alerts.map((a) => a.code);

describe('a park with nothing wrong', () => {
    it('is green and raises nothing', () => {
        const { alerts, health } = evaluate(healthy());
        expect(alerts).toEqual([]);
        expect(health).toBe('green');
    });
});

describe('red — rides are being lost now', () => {
    it('flags an open park with no dispatcher on shift', () => {
        const { alerts, health } = evaluate(healthy({ dispatchersOnShift: [] }));
        expect(codes(alerts)).toContain('no_dispatcher_on_shift');
        expect(health).toBe('red');
    });

    it('flags a park with nobody assignable', () => {
        const { alerts, health } = evaluate(healthy({ driversPresent: 0, driversAssignable: 0 }));
        expect(codes(alerts)).toContain('no_assignable_drivers');
        expect(health).toBe('red');
    });

    /*
     * The subtle one. Drivers are present, so the park is offered rides — and
     * the dispatcher then cannot assign any of them. Distinguished from an
     * empty park because the fix is different: badges, not attendance.
     */
    it('distinguishes present-but-unassignable, and says to check badges', () => {
        const { alerts } = evaluate(healthy({ driversPresent: 3, driversAssignable: 0 }));
        const alert = alerts.find((a: any) => a.code === 'no_assignable_drivers');
        expect(alert.message).toContain('3 driver(s) present');
        expect(alert.action).toContain('badge');
    });

    it('flags push failing, because a dispatcher may never be woken', () => {
        const { alerts, health } = evaluate(healthy({ pushFailureRatePct: 60, pushFailedToday: 6 }));
        expect(codes(alerts)).toContain('push_failing');
        expect(health).toBe('red');
    });

    it('flags a total GPS blackout as red and partial staleness as amber', () => {
        const blackout = evaluate(healthy({ gpsHealthy: 0, gpsStale: 4 }));
        expect(blackout.health).toBe('red');

        const partial = evaluate(healthy({ gpsHealthy: 3, gpsStale: 1 }));
        expect(codes(partial.alerts)).toContain('gps_heartbeat_lost');
        expect(partial.health).toBe('amber');
    });

    it('flags a park switched off during its own operating hours', () => {
        const { alerts, health } = evaluate(healthy({
            parkStatus: ParkStatus.SUSPENDED,
            operationalStatus: 'offline',
        }));
        expect(codes(alerts)).toContain('closed_during_operating_hours');
        expect(health).toBe('red');
    });
});

describe('amber — will lose rides unless somebody acts', () => {
    it('flags a dispatcher who has done nothing for a long time', () => {
        const { alerts, health } = evaluate(healthy({
            dispatchersOnShift: [{ staffUserId: 's1', name: 'Ada', shiftMinutes: 120, lastActivityMinutes: 45 }],
        }));
        expect(codes(alerts)).toContain('dispatcher_inactive');
        expect(health).toBe('amber');
    });

    it('flags a queue that is running away', () => {
        const { alerts, health } = evaluate(healthy({ queueLength: 9 }));
        expect(codes(alerts)).toContain('queue_over_threshold');
        expect(health).toBe('amber');
    });

    it('flags requests taking too long to be picked up', () => {
        const { alerts, health } = evaluate(healthy({ avgDispatchSeconds: 240 }));
        expect(codes(alerts)).toContain('dispatch_latency_high');
        expect(health).toBe('amber');
    });
});

describe('what must NOT raise an alarm', () => {
    /*
     * A shop shut at night is not broken. Colouring a closed park red every
     * evening is how a panel becomes wallpaper.
     */
    it('leaves a closed park green with no staff and no drivers', () => {
        const { alerts, health } = evaluate(healthy({
            operationalStatus: 'closed',
            withinOperatingHours: false,
            dispatchersOnShift: [],
            driversPresent: 0,
            driversAssignable: 0,
            gpsHealthy: 0,
            gpsStale: 0,
        }));
        expect(alerts).toEqual([]);
        expect(health).toBe('green');
    });

    it('says nothing about push when no alert has been sent today', () => {
        const { alerts } = evaluate(healthy({ pushFailureRatePct: null, pushAcceptedToday: 0, pushFailedToday: 0 }));
        expect(codes(alerts)).not.toContain('push_failing');
    });

    it('says nothing about latency before any request has been dispatched', () => {
        const { alerts } = evaluate(healthy({ avgDispatchSeconds: null, successfulDispatchPct: null }));
        expect(codes(alerts)).not.toContain('dispatch_latency_high');
    });
});

describe('every alert is actionable', () => {
    /*
     * An alert somebody cannot act on trains them to ignore the panel it lives
     * in, so each one must name what to do.
     */
    it('carries an action and a message', () => {
        const broken = healthy({
            dispatchersOnShift: [],
            driversPresent: 0,
            driversAssignable: 0,
            pushFailureRatePct: 80,
            gpsHealthy: 0,
            gpsStale: 2,
            queueLength: 12,
            avgDispatchSeconds: 300,
        });
        const { alerts } = evaluate(broken);

        expect(alerts.length).toBeGreaterThan(3);
        for (const a of alerts) {
            expect(a.message.trim().length).toBeGreaterThan(0);
            expect(a.action.trim().length).toBeGreaterThan(0);
            expect(['red', 'amber']).toContain(a.severity);
        }
    });
});
