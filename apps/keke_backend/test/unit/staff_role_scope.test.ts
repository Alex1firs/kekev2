/**
 * Park scoping of staff roles.
 *
 * Every grant used to be written with `parkId: null`, and a null park means
 * every park — `staffParkScope` returns '*' for it. So every dispatcher ever
 * created could claim and assign rides at every park in the network. With one
 * park that is invisible; with two it is a real breach of the boundary the
 * roles exist to draw.
 *
 * `parseRoles` is where a park is now accepted or refused, so that is what is
 * tested: the shape it takes, and the rule that only park-bound roles may be
 * confined.
 */

import { StaffRole } from '../../src/config/staff_permissions';

const parseRoles = (input: unknown) =>
    (require('../../src/services/staff_service').StaffService as any).parseRoles(input);

describe('role park scoping', () => {
    it('treats a bare role name as global, exactly as before', () => {
        expect(parseRoles([StaffRole.PARK_DISPATCHER]))
            .toEqual([{ role: StaffRole.PARK_DISPATCHER, parkId: null }]);
    });

    it('accepts a park for a park-bound role', () => {
        expect(parseRoles([{ role: StaffRole.PARK_DISPATCHER, parkId: 'park-1' }]))
            .toEqual([{ role: StaffRole.PARK_DISPATCHER, parkId: 'park-1' }]);
    });

    it('accepts an explicit null park as global', () => {
        expect(parseRoles([{ role: StaffRole.PARK_SUPERVISOR, parkId: null }]))
            .toEqual([{ role: StaffRole.PARK_SUPERVISOR, parkId: null }]);
    });

    /*
     * The same person may cover two parks. Keyed on role AND park, so this is
     * two grants — keyed on role alone the second silently vanished, which is
     * how a dispatcher added to a second park never appeared there.
     */
    it('keeps one role granted at two different parks as two grants', () => {
        const parsed = parseRoles([
            { role: StaffRole.PARK_DISPATCHER, parkId: 'park-1' },
            { role: StaffRole.PARK_DISPATCHER, parkId: 'park-2' },
        ]);
        expect(parsed).toHaveLength(2);
        expect(parsed.map((r: any) => r.parkId).sort()).toEqual(['park-1', 'park-2']);
    });

    it('collapses an exact duplicate', () => {
        expect(parseRoles([
            { role: StaffRole.CASHIER, parkId: 'park-1' },
            { role: StaffRole.CASHIER, parkId: 'park-1' },
        ])).toHaveLength(1);
    });

    /*
     * An operations admin confined to one park is a contradiction: the role
     * exists to see across parks. Accepting the park silently would produce an
     * account whose authority did not match its name.
     */
    it.each([
        StaffRole.SUPER_ADMIN,
        StaffRole.OPERATIONS_ADMIN,
        StaffRole.SUPPORT_OFFICER,
    ])('refuses to confine %s to a park', (role) => {
        expect(() => parseRoles([{ role, parkId: 'park-1' }]))
            .toThrow(/not a park role/);
    });

    it.each([
        StaffRole.PARK_SUPERVISOR,
        StaffRole.PARK_DISPATCHER,
        StaffRole.CASHIER,
    ])('allows %s to be confined to a park', (role) => {
        expect(parseRoles([{ role, parkId: 'park-9' }]))
            .toEqual([{ role, parkId: 'park-9' }]);
    });

    it('still rejects an unknown role', () => {
        expect(() => parseRoles(['NOT_A_ROLE'])).toThrow(/Unknown role/);
        expect(() => parseRoles([{ role: 'NOT_A_ROLE', parkId: null }])).toThrow(/Unknown role/);
    });

    it('accepts a mixture of scoped and global grants', () => {
        const parsed = parseRoles([
            StaffRole.SUPPORT_OFFICER,
            { role: StaffRole.PARK_DISPATCHER, parkId: 'park-1' },
        ]);
        expect(parsed).toHaveLength(2);
        expect(parsed.find((r: any) => r.role === StaffRole.SUPPORT_OFFICER).parkId).toBeNull();
        expect(parsed.find((r: any) => r.role === StaffRole.PARK_DISPATCHER).parkId).toBe('park-1');
    });
});
