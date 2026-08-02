/**
 * The operations event feed: what is happening, in words, with the ids to chase it.
 *
 * ── Why a translation layer ─────────────────────────────────────────────
 * `dispatch_event` already records everything this feed shows — it is the trace
 * the dispatch engine writes as it works, and it is complete. What it is not is
 * readable: it holds forty-odd event types at engine granularity
 * (`candidate_discovered`, `reservation_conflict`, `eligibility_rejected`)
 * because it exists to debug dispatch, not to run a park.
 *
 * An operator watching a network needs nine things, and needs them named the
 * way they would say them out loud. So this maps the engine's vocabulary onto
 * that, drops what is noise at this altitude, and keeps every id so anybody can
 * drop back down into the full trace for one ride.
 *
 * Nothing is instrumented here. If this file were deleted the engine would
 * record exactly what it records today.
 */

import { In } from 'typeorm';
import { AppDataSource } from '../config/data_source';
import { DispatchEvent, DispatchEventType } from '../models/DispatchEvent';
import { Ride } from '../models/Ride';
import { Park } from '../models/Park';

/** What operations watches. Nine things, in their words. */
export type OpsEventKind =
    | 'ride_requested'
    | 'dispatcher_notified'
    | 'driver_selected'
    | 'driver_accepted'
    | 'driver_rejected'
    | 'passenger_cancelled'
    | 'driver_cancelled'
    | 'timeout'
    | 'assignment_failed';

export interface OpsEvent {
    /** Stable id, so a client can de-duplicate across polls. */
    id: string;
    at: string;
    kind: OpsEventKind;
    /** One line, already written for a person. */
    summary: string;
    severity: 'info' | 'warn' | 'error';

    rideId: string | null;
    parkId: string | null;
    parkName: string | null;
    driverId: string | null;
    /** The raw engine event, for anyone dropping into the full trace. */
    sourceType: string;
}

/**
 * Engine event → operations event.
 *
 * Anything absent from this table is deliberately not surfaced: it is either
 * engine detail (candidate discovery, reservation mechanics) or a duplicate of
 * something already listed. Adding a row here is how the feed grows — there is
 * no catch-all, because a feed that shows everything shows nothing.
 */
const MAPPING: Partial<Record<DispatchEventType, { kind: OpsEventKind; severity: OpsEvent['severity'] }>> = {
    [DispatchEventType.RIDE_CREATED]: { kind: 'ride_requested', severity: 'info' },

    // A park being offered the ride IS the dispatcher being notified: the push
    // and the socket broadcast both hang off this moment.
    [DispatchEventType.PARK_OFFERED]: { kind: 'dispatcher_notified', severity: 'info' },

    [DispatchEventType.PARK_DRIVER_OFFERED]: { kind: 'driver_selected', severity: 'info' },
    [DispatchEventType.PARK_DRIVER_ASSIGNED]: { kind: 'driver_selected', severity: 'info' },

    [DispatchEventType.DRIVER_ACCEPTED]: { kind: 'driver_accepted', severity: 'info' },
    [DispatchEventType.PARK_DRIVER_ACCEPTED]: { kind: 'driver_accepted', severity: 'info' },

    [DispatchEventType.DRIVER_REJECTED]: { kind: 'driver_rejected', severity: 'warn' },
    [DispatchEventType.PARK_DRIVER_DECLINED]: { kind: 'driver_rejected', severity: 'warn' },

    [DispatchEventType.OFFER_EXPIRED]: { kind: 'timeout', severity: 'warn' },
    [DispatchEventType.PARK_JOB_EXPIRED]: { kind: 'timeout', severity: 'warn' },

    [DispatchEventType.DISPATCH_FAILED]: { kind: 'assignment_failed', severity: 'error' },
    [DispatchEventType.PARK_DISPATCH_EXHAUSTED]: { kind: 'assignment_failed', severity: 'error' },

    // Split into passenger/driver below, from the event's own detail.
    [DispatchEventType.RIDE_CANCELLED]: { kind: 'passenger_cancelled', severity: 'warn' },
};

const WATCHED = Object.keys(MAPPING) as DispatchEventType[];

export interface FeedQuery {
    parkId?: string | null;
    kinds?: OpsEventKind[];
    /**
     * Poll cursor: an ISO timestamp, not an id.
     *
     * The primary key is a UUID, so `id > lastId` compares two random strings
     * and is unrelated to insertion order — it would have silently returned the
     * wrong events. Time is the only ordering this table actually has.
     *
     * Events sharing a millisecond can repeat across polls, so every event
     * carries a stable `id` for the client to de-duplicate on.
     */
    since?: string | null;
    limit?: number;
}

export class OperationsEventFeedService {
    static async list(query: FeedQuery = {}): Promise<{ events: OpsEvent[]; latestAt: string | null }> {
        const limit = Math.min(Math.max(Number(query.limit) || 100, 1), 300);

        const qb = AppDataSource.getRepository(DispatchEvent)
            .createQueryBuilder('e')
            .where('e."eventType" IN (:...types)', { types: WATCHED })
            .orderBy('e."createdAt"', 'DESC')
            .addOrderBy('e."sequence"', 'DESC')
            .take(limit);

        /*
         * Park filtering goes through the ride, because most engine events
         * predate the ride reaching a park and carry no parkId of their own —
         * filtering on the event's own column would silently drop the request
         * that the park was later offered, which is the one an operator is
         * usually looking for.
         */
        if (query.parkId) {
            qb.andWhere(`e."rideId" IN (${AppDataSource.getRepository(Ride)
                .createQueryBuilder('r')
                .select('r."rideId"')
                .where('r."parkId" = :parkId')
                .getQuery()})`, { parkId: query.parkId });
        }

        if (query.since) {
            const cursor = new Date(query.since);
            if (!Number.isNaN(cursor.getTime())) {
                qb.andWhere('e."createdAt" > :since', { since: cursor });
            }
        }

        const rows = await qb.getMany();
        const events = await this.decorate(rows);

        const filtered = query.kinds?.length
            ? events.filter((e) => query.kinds!.includes(e.kind))
            : events;

        return {
            events: filtered,
            // From the unfiltered rows: a client polling with a kind filter
            // must still advance past events it chose not to display, or it
            // re-reads them forever.
            latestAt: rows.length ? new Date(rows[0].createdAt).toISOString() : null,
        };
    }

    private static async decorate(rows: DispatchEvent[]): Promise<OpsEvent[]> {
        const parkIds = [...new Set(rows.map((r) => (r.detail as any)?.parkId).filter(Boolean))] as string[];
        const parks = parkIds.length
            ? await AppDataSource.getRepository(Park).find({ where: { parkId: In(parkIds) } })
            : [];
        const parkName = new Map(parks.map((p) => [p.parkId, p.name]));

        return rows.map((row) => {
            const detail = (row.detail ?? {}) as Record<string, any>;
            const mapped = MAPPING[row.eventType as DispatchEventType]!;

            /*
             * A cancellation is two different operational events depending on
             * who walked away, and they need different responses: a passenger
             * changing their mind is normal, a driver abandoning an accepted
             * ride is a driver-behaviour problem.
             */
            let kind = mapped.kind;
            if (row.eventType === DispatchEventType.RIDE_CANCELLED) {
                const by = String(detail.cancelledBy ?? detail.actor ?? '').toLowerCase();
                kind = by.includes('driver') ? 'driver_cancelled' : 'passenger_cancelled';
            }

            const pid = detail.parkId ?? null;
            return {
                id: String(row.id),
                at: new Date(row.createdAt).toISOString(),
                kind,
                summary: this.summarise(kind, detail, parkName.get(pid) ?? null),
                severity: mapped.severity,
                rideId: row.rideId ?? null,
                parkId: pid,
                parkName: pid ? parkName.get(pid) ?? null : null,
                driverId: detail.driverId ?? row.driverId ?? null,
                sourceType: row.eventType,
            };
        });
    }

    /**
     * One line a person can act on.
     *
     * Says what happened and, where the engine recorded one, why — a failure
     * whose reason is `no_assignable_driver` is a different afternoon from one
     * whose reason is `outside_service_radius`, and making somebody open the
     * trace to tell them apart defeats the point of the feed.
     */
    private static summarise(kind: OpsEventKind, detail: Record<string, any>, park: string | null): string {
        const at = park ? ` at ${park}` : '';
        switch (kind) {
            case 'ride_requested':
                return `Passenger requested a ride${detail.paymentMode ? ` (${detail.paymentMode})` : ''}.`;
            case 'dispatcher_notified':
                return `Request offered to the dispatcher${at}.`;
            case 'driver_selected':
                return `Dispatcher selected a driver${at}.`;
            case 'driver_accepted':
                return `Driver accepted${at}.`;
            case 'driver_rejected':
                return `Driver declined${at}.`;
            case 'passenger_cancelled':
                return `Passenger cancelled${detail.reason ? `: ${detail.reason}` : '.'}`;
            case 'driver_cancelled':
                return `Driver cancelled${detail.reason ? `: ${detail.reason}` : '.'}`;
            case 'timeout':
                return `Offer expired with no answer${at}.`;
            case 'assignment_failed': {
                const why = detail.reason ?? detail.outcomeCode ?? detail.stopReason;
                const considered = Array.isArray(detail.considered) && detail.considered.length
                    ? ` (${detail.considered.map((c: any) => c.reason).join(', ')})`
                    : '';
                return why
                    ? `No driver could be found: ${String(why).replace(/_/g, ' ')}${considered}.`
                    : 'No driver could be found.';
            }
            default:
                return 'Event recorded.';
        }
    }
}
