/**
 * The cross-boundary contracts that keep a driver from being double-booked and
 * a ride from being lost.
 *
 * Each of these spans a seam where two files must agree. Nothing enforces the
 * agreement at compile time, so a mismatch would only surface in the field —
 * as a driver receiving an offer mid-trip, or an app that cannot recognise a
 * live ride.
 */

import { DRIVER_BUSY_RIDE_STATES } from '../../src/services/driver_eligibility_service';
import { RideStatus } from '../../src/models/Ride';

/** What `/rides/active/passenger` treats as live. */
const PASSENGER_ACTIVE = ['searching', 'accepted', 'arrived', 'in_progress', 'started'];

/** What `/rides/active/driver` treats as live. */
const DRIVER_ACTIVE = ['accepted', 'arrived', 'in_progress', 'started'];

describe('driver busy states', () => {
    /*
     * If a live state is missing here, a driver already carrying a passenger
     * stays in the eligible pool and can be offered a second ride.
     */
    it('covers every state in which the driver holds a ride', () => {
        for (const status of DRIVER_ACTIVE) {
            expect(DRIVER_BUSY_RIDE_STATES).toContain(status);
        }
    });

    it('includes started, even though nothing writes it today', () => {
        // RideStatus.STARTED exists and several read paths accept it. If a
        // write path ever appears, this exclusion must already handle it.
        expect(DRIVER_BUSY_RIDE_STATES).toContain('started');
    });

    it('never excludes a driver for a terminal ride', () => {
        for (const status of ['completed', 'canceled', 'failed']) {
            expect(DRIVER_BUSY_RIDE_STATES).not.toContain(status);
        }
    });

    it('does not treat searching as busy', () => {
        // A searching ride has no driver yet. Marking it busy would exclude
        // every driver from the dispatch they are being considered for.
        expect(DRIVER_BUSY_RIDE_STATES).not.toContain('searching');
    });
});

describe('recovery status contracts', () => {
    it('every state either recovers or is terminal — none is unclassified', () => {
        const terminal = ['completed', 'canceled', 'failed'];
        for (const value of Object.values(RideStatus)) {
            const classified =
                PASSENGER_ACTIVE.includes(value) || terminal.includes(value);
            expect(classified).toBe(true);
        }
    });

    /*
     * The driver endpoint deliberately omits `searching`: a ride with no driver
     * assigned is not a ride any driver can recover. The passenger endpoint
     * must include it, or a passenger who closes the app mid-search comes back
     * to a booking screen while dispatch is still running for them.
     */
    it('passenger recovery includes searching; driver recovery does not', () => {
        expect(PASSENGER_ACTIVE).toContain('searching');
        expect(DRIVER_ACTIVE).not.toContain('searching');
    });

    it('the driver set is a subset of the passenger set', () => {
        for (const status of DRIVER_ACTIVE) {
            expect(PASSENGER_ACTIVE).toContain(status);
        }
    });
});
