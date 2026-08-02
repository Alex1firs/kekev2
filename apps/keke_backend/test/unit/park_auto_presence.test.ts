/**
 * Automatic park presence, and the lines it must not cross.
 *
 * The value of this feature is that a smartphone driver stops needing a human
 * to retype what their phone already reports. The risk is that it starts
 * overruling humans, or quietly makes somebody assignable who should not be.
 * Most of what follows guards the second thing.
 */

import { ParkAutoPresenceService } from '../../src/services/park_auto_presence_service';
import { DriverPresenceState, PresenceSource } from '../../src/models/DriverPresence';
import { ParkStatus } from '../../src/models/Park';
import { RosterStatus } from '../../src/models/ParkDriverRoster';

// ── Test doubles ────────────────────────────────────────────────────────

const setState = jest.fn();

const state = {
    profile: null as any,
    rosters: [] as any[],
    parks: [] as any[],
    presence: null as any,
};

jest.mock('../../src/config/data_source', () => ({
    AppDataSource: {
        getRepository: (entity: any) => {
            const name = entity?.name ?? '';
            if (name === 'DriverProfile') return { findOneBy: async () => state.profile };
            if (name === 'ParkDriverRoster') return { find: async () => state.rosters };
            if (name === 'Park') return { find: async () => state.parks };
            if (name === 'DriverPresence') return { findOneBy: async () => state.presence };
            throw new Error(`unexpected repository: ${name}`);
        },
    },
}));

jest.mock('../../src/services/driver_presence_service', () => ({
    DriverPresenceService: { setState: (...args: any[]) => setState(...args) },
}));

// No throttling in tests: each case is one deliberate evaluation.
jest.mock('../../src/config/redis', () => ({
    redis: { set: async () => 'OK' },
}));

jest.mock('../../src/services/park_service', () => ({
    ParkService: { isWithinOperatingHours: () => true },
}));

// ── Fixtures ────────────────────────────────────────────────────────────

const PARK_ID = 'park-1';

/** The park sits at the origin; distances below are metres from it. */
function park(overrides: Partial<any> = {}) {
    return {
        parkId: PARK_ID,
        lat: 6.16165,
        lng: 6.77668,
        operatingRadiusM: 200,
        status: ParkStatus.ACTIVE,
        ...overrides,
    };
}

/**
 * A point roughly `metres` north of the park.
 * One degree of latitude is ~111,320 m; precision beyond that is irrelevant
 * here because every assertion is well clear of the boundary.
 */
function metresNorth(metres: number) {
    return { lat: 6.16165 + metres / 111_320, lng: 6.77668 };
}

function presence(overrides: Partial<any> = {}) {
    return {
        driverId: 'driver-1',
        state: DriverPresenceState.OFFLINE,
        parkId: null,
        source: PresenceSource.SYSTEM,
        ...overrides,
    };
}

beforeEach(() => {
    setState.mockReset();
    state.profile = { userId: 'driver-1', deviceCapability: 'smartphone', status: 'approved' };
    state.rosters = [{ parkId: PARK_ID, driverId: 'driver-1', status: RosterStatus.ACTIVE }];
    state.parks = [park()];
    state.presence = presence();
});

const heartbeat = (p: { lat: number; lng: number }) =>
    ParkAutoPresenceService.onHeartbeat('driver-1', p.lat, p.lng);

// ── What it should do ───────────────────────────────────────────────────

describe('arriving at the park', () => {
    it('marks a smartphone driver present when they are inside the radius', async () => {
        await heartbeat(metresNorth(50));

        expect(setState).toHaveBeenCalledTimes(1);
        expect(setState).toHaveBeenCalledWith(expect.objectContaining({
            driverId: 'driver-1',
            state: DriverPresenceState.AT_PARK,
            parkId: PARK_ID,
            source: PresenceSource.DRIVER_APP,
        }));
    });

    it('does nothing when they are outside the radius', async () => {
        await heartbeat(metresNorth(4000));
        expect(setState).not.toHaveBeenCalled();
    });

    it('does not re-mark a driver who is already present', async () => {
        state.presence = presence({ state: DriverPresenceState.AT_PARK, parkId: PARK_ID });
        await heartbeat(metresNorth(50));
        expect(setState).not.toHaveBeenCalled();
    });
});

describe('leaving the park', () => {
    it('returns an auto-marked driver to online once they are well clear', async () => {
        state.presence = presence({
            state: DriverPresenceState.AT_PARK,
            parkId: PARK_ID,
            source: PresenceSource.DRIVER_APP,
        });

        await heartbeat(metresNorth(1000));

        expect(setState).toHaveBeenCalledWith(expect.objectContaining({
            state: DriverPresenceState.ONLINE,
            parkId: null,
        }));
    });

    it('holds presence inside the exit margin, so GPS noise cannot flap it', async () => {
        state.presence = presence({
            state: DriverPresenceState.AT_PARK,
            parkId: PARK_ID,
            source: PresenceSource.DRIVER_APP,
        });

        // Past the 200 m radius but inside the 75 m exit margin.
        await heartbeat(metresNorth(240));

        expect(setState).not.toHaveBeenCalled();
    });
});

// ── What it must never do ───────────────────────────────────────────────

describe('boundaries', () => {
    it('never touches a feature-phone driver', async () => {
        state.profile.deviceCapability = 'feature_phone';
        await heartbeat(metresNorth(10));
        expect(setState).not.toHaveBeenCalled();
    });

    it('never overrides presence a dispatcher set', async () => {
        state.presence = presence({
            state: DriverPresenceState.UNAVAILABLE,
            parkId: PARK_ID,
            source: PresenceSource.DISPATCHER,
        });

        await heartbeat(metresNorth(10));
        expect(setState).not.toHaveBeenCalled();
    });

    it('never demotes a dispatcher’s WAITING to AT_PARK', async () => {
        state.presence = presence({
            state: DriverPresenceState.WAITING,
            parkId: PARK_ID,
            source: PresenceSource.DISPATCHER,
        });

        await heartbeat(metresNorth(10));
        expect(setState).not.toHaveBeenCalled();
    });

    it('never moves a driver who is on a ride', async () => {
        state.presence = presence({
            state: DriverPresenceState.EN_ROUTE,
            parkId: PARK_ID,
            source: PresenceSource.SYSTEM,
        });

        await heartbeat(metresNorth(10));
        expect(setState).not.toHaveBeenCalled();
    });

    it('never makes an unapproved driver assignable', async () => {
        state.profile.status = 'pending';
        await heartbeat(metresNorth(10));
        expect(setState).not.toHaveBeenCalled();
    });

    it('ignores a driver who is not on any active roster', async () => {
        state.rosters = [];
        await heartbeat(metresNorth(10));
        expect(setState).not.toHaveBeenCalled();
    });

    it('ignores a park that is not active', async () => {
        state.parks = [park({ status: ParkStatus.DRAFT })];
        await heartbeat(metresNorth(10));
        expect(setState).not.toHaveBeenCalled();
    });

    it('swallows failures rather than breaking the heartbeat', async () => {
        setState.mockRejectedValueOnce(new Error('database is down'));
        await expect(heartbeat(metresNorth(10))).resolves.toBeUndefined();
    });
});
