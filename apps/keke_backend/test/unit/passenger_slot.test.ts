/**
 * Per-passenger active-ride slot: leak and orphan recovery.
 *
 * Written from a live production incident. A passenger was locked out of
 * booking for hours: their Redis slot pointed at RIDE-1785038873948, a ride that
 * had no row in the database and no dispatch events, because the DB guard
 * emitted ACTIVE_RIDE_EXISTS and returned WITHOUT releasing the slot guard (A)
 * had just claimed. Every retry then failed guard (A) instead, so the lockout
 * outlived the ride that originally caused it.
 */
import { DispatchService } from '../../src/services/dispatch_service';
import { newPassenger, newRide, redis } from '../helpers/dispatch';

describe('passenger active-ride slot', () => {
    it('is claimed exactly once for concurrent requests', async () => {
        const passengerId = newPassenger();
        const [a, b] = [newRide(), newRide()];

        const [wonA, wonB] = await Promise.all([
            DispatchService.acquirePassengerActive(passengerId, a),
            DispatchService.acquirePassengerActive(passengerId, b),
        ]);

        expect([wonA, wonB].filter(Boolean)).toHaveLength(1);
        expect(await DispatchService.getPassengerActive(passengerId)).toBe(wonA ? a : b);
    });

    it('releases only for the ride that owns it', async () => {
        const passengerId = newPassenger();
        const owner = newRide();
        const other = newRide();
        await DispatchService.acquirePassengerActive(passengerId, owner);

        // A different ride must not be able to free someone else's slot.
        expect(await DispatchService.releasePassengerActive(passengerId, other)).toBe(false);
        expect(await DispatchService.getPassengerActive(passengerId)).toBe(owner);

        expect(await DispatchService.releasePassengerActive(passengerId, owner)).toBe(true);
        expect(await DispatchService.getPassengerActive(passengerId)).toBeNull();
    });

    it('a blocked request must not leave its slot behind', async () => {
        // Exactly the production sequence: guard (A) claims the slot for the new
        // ride, guard (B) then blocks on a pre-existing accepted ride. The new
        // ride is abandoned, so its slot has to go with it.
        const passengerId = newPassenger();
        const abandonedRideId = newRide();

        expect(await DispatchService.acquirePassengerActive(passengerId, abandonedRideId)).toBe(true);
        await DispatchService.releasePassengerActive(passengerId, abandonedRideId);

        expect(await DispatchService.getPassengerActive(passengerId)).toBeNull();
        // The next attempt can claim cleanly rather than colliding with a ghost.
        expect(await DispatchService.acquirePassengerActive(passengerId, newRide())).toBe(true);
    });

    describe('orphan detection by slot age', () => {
        it('reports no age when no slot is held', async () => {
            expect(await DispatchService.getPassengerActiveAgeMs(newPassenger())).toBeNull();
        });

        it('reports a freshly claimed slot as newborn', async () => {
            const passengerId = newPassenger();
            await DispatchService.acquirePassengerActive(passengerId, newRide());

            const age = await DispatchService.getPassengerActiveAgeMs(passengerId);
            expect(age).not.toBeNull();
            // A simultaneous sibling still committing its row looks like this, and
            // must keep being treated as a real block.
            expect(age!).toBeLessThan(5_000);
        });

        it('reports an aged slot as old enough to be an orphan', async () => {
            const passengerId = newPassenger();
            const key = DispatchService.passengerActiveKey(passengerId);
            // Shorten the TTL to simulate a slot claimed long ago; age is derived
            // from the remaining TTL, so this is equivalent to the passage of time
            // without waiting for it.
            await redis.set(key, newRide(), 'EX', DispatchService.PASSENGER_ACTIVE_TTL_SECONDS - 600);

            const age = await DispatchService.getPassengerActiveAgeMs(passengerId);
            expect(age).not.toBeNull();
            expect(age!).toBeGreaterThan(30_000);
        });

        it('derives age from the server TTL, not the client-generated ride id', async () => {
            // Ride ids embed a client clock (RIDE-<epochMs>) and cannot be trusted
            // to date anything, so age must come from Redis.
            const passengerId = newPassenger();
            await DispatchService.acquirePassengerActive(passengerId, 'RIDE-1');
            const age = await DispatchService.getPassengerActiveAgeMs(passengerId);
            expect(age!).toBeLessThan(5_000);
        });
    });

    it('a released slot lets the passenger book again immediately', async () => {
        const passengerId = newPassenger();
        const stuck = newRide();
        await DispatchService.acquirePassengerActive(passengerId, stuck);

        // What clearing the orphaned key by hand does, and what the guard now
        // does on its own once the slot is older than the grace period.
        await DispatchService.releasePassengerActive(passengerId);

        expect(await DispatchService.acquirePassengerActive(passengerId, newRide())).toBe(true);
    });
});
