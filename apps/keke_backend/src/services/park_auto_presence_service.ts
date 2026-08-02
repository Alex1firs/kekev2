/**
 * Mark a smartphone driver present when their own phone says they are at the park.
 *
 * ── Why this exists ─────────────────────────────────────────────────────
 * A park is only offered a ride when it has a driver in an assignable presence
 * state, and until now the only way into that state was a dispatcher tapping a
 * button. For a driver carrying a smartphone that is redundant data entry: the
 * phone is already reporting its position every few seconds, and asking a human
 * to retype what the system can see is how a park ends up with drivers sitting
 * in it and a board that says nobody is there.
 *
 * ── What it deliberately does NOT do ────────────────────────────────────
 * - It never touches a feature-phone driver. They have no phone to report for
 *   themselves, so a human records their arrival and that stays true.
 * - It never overrides a person. If a dispatcher or an administrator set the
 *   current state, this leaves it alone — a human who marked somebody
 *   unavailable meant it, and a GPS ping is not an argument against them.
 * - It never touches a driver who is on a ride. Those states belong to the ride
 *   and are moved by the dispatch and trip flows.
 * - It is not part of dispatch. It is called after the heartbeat's dispatch work
 *   is already done, and every failure is swallowed: a driver's location must
 *   keep flowing to their passenger even if presence bookkeeping fails.
 */

import { In } from 'typeorm';
import { AppDataSource } from '../config/data_source';
import { DriverProfile } from '../models/DriverProfile';
import { Park } from '../models/Park';
import { ParkDriverRoster, RosterStatus } from '../models/ParkDriverRoster';
import { DriverPresence, DriverPresenceState, PresenceSource } from '../models/DriverPresence';
import { DriverPresenceService } from './driver_presence_service';
import { ParkService } from './park_service';
import { haversineMeters } from './ride_integrity_service';
import { redis } from '../config/redis';

/**
 * How much further than the park's own radius a driver must travel before we
 * call them gone.
 *
 * Without hysteresis a driver parked exactly on the boundary flickers between
 * present and absent as GPS noise moves them a few metres, and each flicker is
 * a presence event, an audit row and a board that will not sit still. Entry
 * uses the park's radius; exit uses the radius plus this.
 */
const EXIT_MARGIN_M = 75;

/**
 * How often one driver's position is worth re-examining.
 *
 * Heartbeats arrive every few seconds per driver. The geofence answer changes
 * on the scale of somebody walking, so evaluating it more often than this buys
 * nothing and costs a roster lookup per ping per driver.
 */
const THROTTLE_SECONDS = 20;

/** States this service is allowed to move a driver OUT of. */
const CLAIMABLE_FROM: DriverPresenceState[] = [
    DriverPresenceState.OFFLINE,
    DriverPresenceState.ONLINE,
];

/**
 * States this service is allowed to move a driver INTO on leaving a park.
 * Only presence it set itself is ever cleared — see `mayAdjust`.
 */
const PRESENT_STATES: DriverPresenceState[] = [
    DriverPresenceState.AT_PARK,
    DriverPresenceState.WAITING,
];

export class ParkAutoPresenceService {
    /**
     * Consider one heartbeat.
     *
     * Never throws. The caller is the socket heartbeat handler, which is on the
     * path that keeps a passenger's map moving; presence is worth strictly less
     * than that.
     */
    static async onHeartbeat(driverId: string, lat: number, lng: number): Promise<void> {
        try {
            if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
            if (!(await this.claimSlot(driverId))) return;
            await this.evaluate(driverId, lat, lng);
        } catch (err) {
            // Deliberately swallowed. A driver whose presence cannot be updated
            // is a driver a dispatcher marks by hand — the old behaviour, not an
            // outage.
            console.warn(JSON.stringify({
                event: 'auto_presence_failed',
                driverId,
                message: (err as Error).message,
            }));
        }
    }

    /**
     * Throttle to one evaluation per driver per window.
     *
     * Redis rather than an in-process map because there is more than one node
     * behind the load balancer and a per-process throttle would let each of them
     * evaluate the same driver.
     *
     * If Redis is unavailable we evaluate anyway: doing the work too often is a
     * cost, and skipping it is a driver who never becomes present.
     */
    private static async claimSlot(driverId: string): Promise<boolean> {
        try {
            const key = `auto_presence:${driverId}`;
            const ok = await redis.set(key, '1', 'EX', THROTTLE_SECONDS, 'NX');
            return ok === 'OK';
        } catch {
            return true;
        }
    }

    private static async evaluate(driverId: string, lat: number, lng: number): Promise<void> {
        const profile = await AppDataSource.getRepository(DriverProfile).findOneBy({ userId: driverId });
        if (!profile) return;

        /*
         * Only smartphone drivers. The whole point of the manual check-in is
         * the driver who cannot report for themselves, and quietly automating
         * them would mean a dispatcher's record of who is standing in front of
         * them being overwritten by a phone that does not exist.
         */
        if (String(profile.deviceCapability ?? '') !== 'smartphone') return;

        // A suspended or unapproved driver must not become assignable by walking
        // into a park. Dispatch would refuse them anyway; this keeps the board
        // honest rather than showing somebody who cannot be given work.
        if (profile.status !== 'approved') return;

        const rosters = await AppDataSource.getRepository(ParkDriverRoster).find({
            where: { driverId, status: RosterStatus.ACTIVE },
        });
        if (rosters.length === 0) return;

        const presenceRepo = AppDataSource.getRepository(DriverPresence);
        const current = await presenceRepo.findOneBy({ driverId });

        const parks = await AppDataSource.getRepository(Park).find({
            where: { parkId: In(rosters.map((r) => r.parkId)) },
        });

        /*
         * Nearest park first. A driver may be rostered at more than one, and
         * two parks whose radii overlap must not fight over them — the closer
         * one wins and the answer is stable while they stand still.
         */
        const ranked = parks
            .map((park) => ({
                park,
                distanceM: haversineMeters(
                    { lat: Number(park.lat), lng: Number(park.lng) },
                    { lat, lng },
                ),
            }))
            .sort((a, b) => a.distanceM - b.distanceM);

        const inside = ranked.find(({ park, distanceM }) => {
            if (park.status !== 'active') return false;
            if (!ParkService.isWithinOperatingHours(park)) return false;
            const radius = Number(park.operatingRadiusM) || 250;
            // Hysteresis: already here, allow a wider ring before calling it a
            // departure.
            const alreadyHere = current?.parkId === park.parkId
                && PRESENT_STATES.includes(current.state);
            return distanceM <= radius + (alreadyHere ? EXIT_MARGIN_M : 0);
        });

        if (inside) {
            await this.markPresent(driverId, inside.park.parkId, current);
        } else {
            await this.markGone(driverId, current);
        }
    }

    /**
     * Whether this service may change the state that is currently in force.
     *
     * The rule is the whole safety story: a state a human put there is theirs.
     * Only presence with a machine source — this service, or the resting state
     * every row starts in — is ours to move.
     */
    private static mayAdjust(current: DriverPresence | null): boolean {
        if (!current) return true;
        return current.source === PresenceSource.SYSTEM
            || current.source === PresenceSource.DRIVER_APP;
    }

    private static async markPresent(
        driverId: string,
        parkId: string,
        current: DriverPresence | null,
    ): Promise<void> {
        // Already assignable at this park: nothing to say. In particular this is
        // what stops an automatic AT_PARK from demoting a dispatcher's WAITING.
        if (current && current.parkId === parkId && PRESENT_STATES.includes(current.state)) return;

        // Anything outside a resting state is either a ride in progress or a
        // human's decision. Neither is ours.
        if (current && !CLAIMABLE_FROM.includes(current.state)) return;
        if (!this.mayAdjust(current)) return;

        await DriverPresenceService.setState({
            driverId,
            state: DriverPresenceState.AT_PARK,
            parkId,
            source: PresenceSource.DRIVER_APP,
            setByStaffId: null,
            note: 'Arrived at the park (reported by the driver app)',
        });
    }

    private static async markGone(driverId: string, current: DriverPresence | null): Promise<void> {
        if (!current) return;
        // Only presence we granted is ours to take away. A dispatcher who marked
        // somebody waiting keeps them waiting until a dispatcher says otherwise.
        if (!PRESENT_STATES.includes(current.state)) return;
        if (!this.mayAdjust(current)) return;

        await DriverPresenceService.setState({
            driverId,
            state: DriverPresenceState.ONLINE,
            parkId: null,
            source: PresenceSource.DRIVER_APP,
            setByStaffId: null,
            note: 'Left the park (reported by the driver app)',
        });
    }
}
