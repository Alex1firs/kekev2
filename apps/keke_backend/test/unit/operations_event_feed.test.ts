/**
 * The operations event feed's translation layer.
 *
 * The feed's whole job is turning engine vocabulary into the nine things an
 * operator watches, without losing the ids that let them investigate. These
 * tests cover the two places that can silently go wrong: a cancellation being
 * attributed to the wrong party, and the poll cursor.
 */

import { OperationsEventFeedService } from '../../src/services/operations_event_feed_service';
import { DispatchEventType } from '../../src/models/DispatchEvent';

const rows: any[] = [];
const captured: { where: string[]; params: Record<string, unknown> } = { where: [], params: {} };

jest.mock('../../src/config/data_source', () => ({
    AppDataSource: {
        getRepository: (entity: any) => {
            const name = entity?.name ?? '';
            if (name === 'Park') return { find: async () => [{ parkId: 'park-1', name: 'Holy Trinity' }] };
            return {
                createQueryBuilder: () => {
                    const qb: any = {
                        select: () => qb,
                        addSelect: () => qb,
                        where: (clause: string, params: any) => {
                            captured.where.push(clause);
                            Object.assign(captured.params, params ?? {});
                            return qb;
                        },
                        andWhere: (clause: string, params: any) => {
                            captured.where.push(clause);
                            Object.assign(captured.params, params ?? {});
                            return qb;
                        },
                        orderBy: () => qb,
                        addOrderBy: () => qb,
                        take: () => qb,
                        getQuery: () => 'SELECT "rideId" FROM ride WHERE "parkId" = :parkId',
                        getMany: async () => rows,
                    };
                    return qb;
                },
            };
        },
    },
}));

function event(overrides: Partial<any> = {}) {
    return {
        id: 'evt-1',
        rideId: 'RIDE-1',
        driverId: null,
        eventType: DispatchEventType.RIDE_CREATED,
        detail: {},
        sequence: 1,
        createdAt: new Date('2026-08-02T09:00:00Z'),
        ...overrides,
    };
}

beforeEach(() => {
    rows.length = 0;
    captured.where = [];
    captured.params = {};
});

describe('translation', () => {
    it('names a ride request in the operator’s words and keeps the ride id', async () => {
        rows.push(event({ detail: { paymentMode: 'cash' } }));

        const { events } = await OperationsEventFeedService.list();

        expect(events).toHaveLength(1);
        expect(events[0].kind).toBe('ride_requested');
        expect(events[0].rideId).toBe('RIDE-1');
        // The raw type survives, so anybody can drop back into the full trace.
        expect(events[0].sourceType).toBe(DispatchEventType.RIDE_CREATED);
    });

    it('explains a failed assignment with the reason the engine recorded', async () => {
        rows.push(event({
            eventType: DispatchEventType.PARK_DISPATCH_EXHAUSTED,
            detail: {
                reason: 'no_eligible_park',
                considered: [{ parkId: 'park-1', reason: 'no_assignable_driver' }],
            },
        }));

        const { events } = await OperationsEventFeedService.list();

        expect(events[0].kind).toBe('assignment_failed');
        expect(events[0].severity).toBe('error');
        // The point of the feed: readable without opening a log.
        expect(events[0].summary).toContain('no eligible park');
        expect(events[0].summary).toContain('no_assignable_driver');
    });

    /*
     * A passenger changing their mind and a driver abandoning an accepted ride
     * are the same engine event and completely different operational problems.
     */
    it('separates a passenger cancellation from a driver one', async () => {
        rows.push(event({ id: 'a', eventType: DispatchEventType.RIDE_CANCELLED, detail: { cancelledBy: 'passenger' } }));
        const passenger = await OperationsEventFeedService.list();
        expect(passenger.events[0].kind).toBe('passenger_cancelled');

        rows.length = 0;
        rows.push(event({ id: 'b', eventType: DispatchEventType.RIDE_CANCELLED, detail: { cancelledBy: 'driver' } }));
        const driver = await OperationsEventFeedService.list();
        expect(driver.events[0].kind).toBe('driver_cancelled');
    });

    it('resolves the park name so the feed reads without ids', async () => {
        rows.push(event({ eventType: DispatchEventType.PARK_OFFERED, detail: { parkId: 'park-1' } }));

        const { events } = await OperationsEventFeedService.list();

        expect(events[0].kind).toBe('dispatcher_notified');
        expect(events[0].parkName).toBe('Holy Trinity');
        expect(events[0].summary).toContain('Holy Trinity');
    });
});

describe('polling', () => {
    /*
     * The primary key is a UUID. An earlier version paged with `id > lastId`,
     * which compares two random strings and returns whatever happens to sort
     * higher — silently wrong rather than obviously broken.
     */
    it('pages on time, never on the uuid primary key', async () => {
        rows.push(event());

        await OperationsEventFeedService.list({ since: '2026-08-02T08:00:00Z' });

        const clauses = captured.where.join(' ');
        expect(clauses).toContain('"createdAt" > :since');
        expect(clauses).not.toContain('"id" >');
        expect(captured.params.since).toBeInstanceOf(Date);
    });

    it('ignores an unparseable cursor rather than returning nothing', async () => {
        rows.push(event());

        const { events } = await OperationsEventFeedService.list({ since: 'not-a-date' });

        expect(captured.where.join(' ')).not.toContain(':since');
        expect(events).toHaveLength(1);
    });

    /*
     * The cursor must come from the unfiltered rows. Taken from the filtered
     * list, a client watching only failures would never advance past a quiet
     * period and would re-read the same page forever.
     */
    it('advances the cursor past events the caller filtered out', async () => {
        rows.push(event({ createdAt: new Date('2026-08-02T09:05:00Z') }));

        const { events, latestAt } = await OperationsEventFeedService.list({ kinds: ['assignment_failed'] });

        expect(events).toHaveLength(0);
        expect(latestAt).toBe(new Date('2026-08-02T09:05:00Z').toISOString());
    });

    it('filters a park through its rides, not the event column', async () => {
        rows.push(event());

        await OperationsEventFeedService.list({ parkId: 'park-1' });

        // Most engine events predate the ride reaching a park and carry no
        // parkId, so filtering on the event's own column would drop them.
        expect(captured.where.join(' ')).toContain('e."rideId" IN');
        expect(captured.params.parkId).toBe('park-1');
    });
});
