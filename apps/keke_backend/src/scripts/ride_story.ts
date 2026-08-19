/**
 * The whole story of one ride, for field commissioning.
 *
 * Assembles what several tables know into the sequence a human would tell it
 * in: who asked, what automatic dispatch tried, whether Operations was
 * alerted, who took control, who was rung, who was assigned, and how it ended.
 *
 * ── No passenger PII ─────────────────────────────────────────────────────
 * Names, phones and emails are deliberately absent. This output gets pasted
 * into chat threads and terminals during a field test; it must be safe to
 * paste. Identity lives in the admin console, masked, behind an audited
 * reveal. Ids are printed so a ride can still be cross-referenced.
 *
 * Usage:
 *   npm run ride:story -- RIDE-1787064063051
 */
import 'reflect-metadata';
import { AppDataSource } from '../config/data_source';
import { Ride } from '../models/Ride';
import { DispatchEvent } from '../models/DispatchEvent';
import { RideDispatchControl } from '../models/RideDispatchControl';
import { OperationsIntervention } from '../models/OperationsIntervention';
import { outcomeLabel, resolveAreaLine } from '../services/ride_outcome';
import { areaOf } from '../services/dispatch_monitor_query_service';

const rideId = process.argv[2];

function secs(a?: Date | null, b?: Date | null): string {
    if (!a || !b) return '—';
    return `${Math.round((new Date(b).getTime() - new Date(a).getTime()) / 1000)}s`;
}

async function main(): Promise<void> {
    if (!rideId) {
        console.error('Usage: npm run ride:story -- <rideId>');
        process.exit(1);
    }
    await AppDataSource.initialize();

    const ride = await AppDataSource.getRepository(Ride).findOne({ where: { rideId } });
    if (!ride) { console.error(`No such ride: ${rideId}`); process.exit(1); }

    const [events, control, interventions] = await Promise.all([
        AppDataSource.getRepository(DispatchEvent).find({ where: { rideId }, order: { sequence: 'ASC' } }),
        AppDataSource.getRepository(RideDispatchControl).findOne({ where: { rideId } }),
        AppDataSource.getRepository(OperationsIntervention).find({ where: { rideId }, order: { createdAt: 'ASC' } }),
    ]);

    const pickup = resolveAreaLine(ride.pickupSubLocality, ride.pickupLocality, areaOf(ride.pickupAddress));
    const dest = resolveAreaLine(ride.destinationSubLocality, ride.destinationLocality, areaOf(ride.destinationAddress));
    const count = (t: string) => events.filter((e) => e.eventType === (t as any)).length;
    const drivers = (t: string) => new Set(events.filter((e) => e.eventType === (t as any) && e.driverId).map((e) => e.driverId!)).size;

    const line = (k: string, v: unknown) => console.log(`  ${k.padEnd(28)} ${v ?? '—'}`);

    console.log(`\n═══ ${rideId} ═══\n`);

    console.log('REQUEST');
    line('requested at', new Date(ride.createdAt).toISOString());
    line('passenger id', ride.passengerId);
    line('pickup area', `${pickup.area ?? 'not recorded'}  [${pickup.source}]`);
    line('destination area', `${dest.area ?? 'not recorded'}  [${dest.source}]`);
    // The Phase 1B question: did the app send structured locality, or did we
    // fall back to parsing prose?
    line('structured locality sent', ride.pickupSubLocality || ride.pickupLocality || ride.pickupCity
        ? `yes (subLocality=${ride.pickupSubLocality ?? '—'}, locality=${ride.pickupLocality ?? '—'}, city=${ride.pickupCity ?? '—'}, state=${ride.pickupState ?? '—'})`
        : 'NO — this build did not send it');
    line('payment', ride.paymentMode);
    line('fare', ride.fare);

    console.log('\nAUTOMATIC DISPATCH');
    line('rounds started', count('round_started'));
    line('widest radius km', Math.max(0, ...events.map((e) => Number(e.radiusKm) || 0)) || '—');
    line('candidates discovered', drivers('candidate_discovered'));
    line('eligibility rejections', count('eligibility_rejected'));
    line('offers queued', drivers('notification_queued'));
    line('socket offers emitted', drivers('socket_offer_emitted'));
    line('push accepted by FCM', drivers('fcm_accepted_by_provider'));
    line('device acks', drivers('device_offer_ack'));
    line('declined', drivers('driver_rejected'));
    line('no answer', drivers('offer_expired'));
    line('dispatch_failed events', count('dispatch_failed'));

    console.log('\nOPERATIONS');
    line('control mode now', control?.mode ?? 'auto (no control row)');
    line('lease owner', control?.ownerLabel ?? '—');
    line('lease owner id', control?.ownerStaffId ?? '—');
    line('taken over at', control?.takenOverAt ? new Date(control.takenOverAt).toISOString() : '—');
    line('lease expires', control?.leaseExpiresAt ? new Date(control.leaseExpiresAt).toISOString() : '—');
    line('last renewed', control?.lastRenewedAt ? new Date(control.lastRenewedAt).toISOString() : '—');
    line('released at', control?.releasedAt ? new Date(control.releasedAt).toISOString() : '—');
    line('release reason', control?.releaseReason ?? '—');
    line('takeovers', control?.takeoverCount ?? 0);
    line('time to takeover', secs(ride.createdAt, control?.takenOverAt));

    if (interventions.length) {
        console.log('\n  interventions:');
        for (const i of interventions) {
            console.log(`    ${new Date(i.createdAt).toISOString()}  ${i.type.padEnd(22)}` +
                ` ${(i.staffLabel ?? 'system').padEnd(16)} ${i.outcome ?? ''} ${i.outcomeCode ?? ''}` +
                `${i.driverId ? ' driver=' + i.driverId : ''}`);
        }
    } else {
        console.log('\n  interventions:            none');
    }

    console.log('\nASSIGNMENT');
    line('driver id', ride.driverId ?? 'never assigned');
    line('dispatch mode', ride.dispatchMode ?? 'direct');
    line('assignment mode', ride.assignmentMode ?? '—');
    // Which source won. The intervention trail is the only place that
    // distinguishes an Operations assignment from an automatic one.
    const opsAssigned = interventions.some((i) => i.type === 'driver_assigned' && i.outcome === 'ok');
    line('assignment source', ride.driverId
        ? (opsAssigned ? 'OPERATIONS (manual)' : ride.dispatchMode === 'park' ? 'PARK' : 'AUTOMATIC')
        : '—');
    line('accepted at', ride.acceptedAt ? new Date(ride.acceptedAt).toISOString() : '—');
    line('time to acceptance', secs(ride.createdAt, ride.acceptedAt));

    console.log('\nTRIP');
    line('arrived at', ride.arrivedAt ? new Date(ride.arrivedAt).toISOString() : '—');
    line('arrival distance m', ride.arrivedPickupDistanceM ?? '—');
    line('started at', ride.startedAt ? new Date(ride.startedAt).toISOString() : '—');
    line('completed at', ride.completedAt ? new Date(ride.completedAt).toISOString() : '—');
    line('trip duration s', ride.tripDurationSec ?? '—');

    console.log('\nOUTCOME');
    line('status', ride.status);
    line('outcome code', ride.outcomeReason ?? 'NOT RECORDED');
    line('outcome label', outcomeLabel(ride.outcomeReason));
    line('outcome detail', ride.outcomeDetail ?? '—');
    line('cancelled by', ride.cancelledByRole ?? '—');

    console.log('\nTIMELINE');
    for (const e of events) {
        const d = e.detail ? JSON.stringify(e.detail).slice(0, 96) : '';
        console.log(`  ${new Date(e.occurredAt).toISOString()}  #${String(e.sequence).padStart(3)}` +
            `  ${e.eventType.padEnd(26)} ${e.driverId ? e.driverId.slice(0, 8) + '…' : '        '} ${d}`);
    }
    console.log('');
    await AppDataSource.destroy();
}

main().catch(async (err) => {
    console.error(err?.message || err);
    try { await AppDataSource.destroy(); } catch { /* already closed */ }
    process.exit(1);
});
