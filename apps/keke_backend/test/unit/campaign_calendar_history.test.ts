/**
 * The calendar, the history diff, and the audience registry.
 *
 * The calendar tests are mostly about refusals: a drag that lands somewhere it
 * should not must fail loudly rather than being interpreted charitably. The
 * charitable interpretation of "dropped on last Tuesday" is "send it now",
 * which is the most expensive thing that screen could do by accident.
 */

import { CampaignCalendarService, RESCHEDULABLE } from '../../src/services/campaign_calendar_service';
import { CampaignHistoryService } from '../../src/services/campaign_history_service';
import { CampaignStatus } from '../../src/models/CommunicationCampaign';
import {
    AUDIENCE_REGISTRY, REGISTERED_AUDIENCES, assertAudienceAvailable, audienceOptions,
} from '../../src/services/audience_registry';

describe('calendar windows', () => {
    it('a day is one day', () => {
        const { from, to } = CampaignCalendarService.windowFor('day', '2026-08-06T13:40:00Z');
        expect(to.getTime() - from.getTime()).toBe(86_400_000);
    });

    it('a week is seven days', () => {
        const { from, to } = CampaignCalendarService.windowFor('week', '2026-08-06T13:40:00Z');
        expect(Math.round((to.getTime() - from.getTime()) / 86_400_000)).toBe(7);
    });

    /*
     * Monday, because Nigeria's working week starts on one and a calendar whose
     * weekend is split across two rows is misread at a glance.
     */
    it('a week starts on Monday', () => {
        for (const d of ['2026-08-03', '2026-08-05', '2026-08-09']) {
            const { from } = CampaignCalendarService.windowFor('week', `${d}T12:00:00`);
            expect(from.getDay()).toBe(1);
        }
    });

    it('a month starts on the first and covers exactly one month', () => {
        const { from, to } = CampaignCalendarService.windowFor('month', '2026-08-20T00:00:00');
        expect(from.getDate()).toBe(1);
        expect(from.getMonth()).toBe(7);
        expect(to.getMonth()).toBe(8);
        expect(to.getDate()).toBe(1);
    });

    it('handles a February window without losing days', () => {
        const { from, to } = CampaignCalendarService.windowFor('month', '2026-02-15T00:00:00');
        expect(Math.round((to.getTime() - from.getTime()) / 86_400_000)).toBe(28);
    });

    it('rejects a date it cannot parse', () => {
        expect(() => CampaignCalendarService.windowFor('day', 'not a date')).toThrow(/Invalid date/);
    });
});

describe('what may be rescheduled', () => {
    it('allows the four pre-send states', () => {
        expect(RESCHEDULABLE).toEqual(expect.arrayContaining([
            CampaignStatus.DRAFT, CampaignStatus.AWAITING_APPROVAL,
            CampaignStatus.APPROVED, CampaignStatus.SCHEDULED,
        ]));
    });

    it.each([
        CampaignStatus.SENDING, CampaignStatus.COMPLETED,
        CampaignStatus.CANCELLED, CampaignStatus.FAILED, CampaignStatus.PAUSED,
    ])('never allows %s', (status) => {
        expect(RESCHEDULABLE).not.toContain(status);
    });
});

describe('the history diff', () => {
    it('reports only the fields that moved', () => {
        const changes = CampaignHistoryService.diff(
            { name: 'Old', objective: 'awareness', segmentId: null },
            { name: 'New', objective: 'awareness', segmentId: null },
        );
        expect(changes).toEqual([{ field: 'name', from: 'Old', to: 'New' }]);
    });

    /*
     * A PATCH touching three fields must not produce a diff claiming twenty
     * changed to the values they already had.
     */
    it('is empty when nothing changed', () => {
        expect(CampaignHistoryService.diff({ a: 1, b: 'x' }, { a: 1, b: 'x' })).toEqual([]);
    });

    it('compares objects by value, not by reference', () => {
        const changes = CampaignHistoryService.diff(
            { audienceDefinition: { activity: 'all' } },
            { audienceDefinition: { activity: 'all' } },
        );
        expect(changes).toEqual([]);
    });

    it('notices a real change inside an object', () => {
        const changes = CampaignHistoryService.diff(
            { audienceDefinition: { activity: 'all' } },
            { audienceDefinition: { activity: 'inactive' } },
        );
        expect(changes).toHaveLength(1);
        expect(changes[0].field).toBe('audienceDefinition');
    });

    it('ignores bookkeeping columns', () => {
        const changes = CampaignHistoryService.diff(
            { updatedAt: new Date(1), createdAt: new Date(1), id: 'a' },
            { updatedAt: new Date(2), createdAt: new Date(2), id: 'b' },
        );
        expect(changes).toEqual([]);
    });

    /*
     * An email body is tens of kilobytes. Storing two copies per edit would
     * make the history larger than everything it describes.
     */
    it('truncates a long value and says how long it was', () => {
        const long = 'x'.repeat(5000);
        const [change] = CampaignHistoryService.diff({ body: 'short' }, { body: long });
        expect(String(change.to)).toMatch(/\(5000 chars\)$/);
        expect(String(change.to).length).toBeLessThan(400);
    });

    it('treats null and undefined as the same absence', () => {
        expect(CampaignHistoryService.diff({ a: null }, { a: undefined })).toEqual([]);
    });

    it('compares dates by value', () => {
        const t = 1_700_000_000_000;
        expect(CampaignHistoryService.diff({ at: new Date(t) }, { at: new Date(t) })).toEqual([]);
    });
});

describe('the audience registry', () => {
    it('names all six audiences', () => {
        expect(Object.keys(AUDIENCE_REGISTRY).sort()).toEqual(
            ['dispatcher', 'driver', 'partner', 'passenger', 'staff', 'supervisor']);
    });

    it('enables passengers and nothing else', () => {
        expect(Array.from(REGISTERED_AUDIENCES)).toEqual(['passenger']);
    });

    it('allows a passenger audience', () => {
        expect(() => assertAudienceAvailable('passenger')).not.toThrow();
    });

    /*
     * The error names the missing prerequisite rather than saying
     * "unsupported", because whoever hits it is usually about to go and build
     * it.
     */
    it.each(['driver', 'dispatcher', 'supervisor', 'staff', 'partner'] as const)(
        'refuses %s and says what is missing', (type) => {
            expect(() => assertAudienceAvailable(type)).toThrow(/not available yet/);
            expect(() => assertAudienceAvailable(type)).toThrow(/Still needed/);
        });

    it('every disabled audience lists at least one prerequisite', () => {
        for (const a of Object.values(AUDIENCE_REGISTRY)) {
            if (!a.enabled) expect(a.prerequisites.length).toBeGreaterThan(0);
        }
    });

    it('only passengers have a consent model, which is why only they are enabled', () => {
        for (const a of Object.values(AUDIENCE_REGISTRY)) {
            if (a.enabled) expect(a.consentModel).toBeTruthy();
            else expect(a.consentModel).toBeNull();
        }
    });

    /*
     * Most driver and staff messaging is operational and belongs in
     * NotificationService at P2, not in a marketing campaign. Flagged on the
     * picker so nobody builds a campaign for something that should be a
     * notification.
     */
    it('flags the audiences whose messaging is mostly operational', () => {
        expect(AUDIENCE_REGISTRY.driver.mostlyOperational).toBe(true);
        expect(AUDIENCE_REGISTRY.dispatcher.mostlyOperational).toBe(true);
        expect(AUDIENCE_REGISTRY.passenger.mostlyOperational).toBe(false);
    });

    it('lists usable audiences first on the picker', () => {
        const opts = audienceOptions();
        expect(opts[0].type).toBe('passenger');
        expect(opts[0].enabled).toBe(true);
    });
});

describe('the template library', () => {
    const { TEMPLATES } = require('../../src/services/email_templates');

    it('covers every requested kind', () => {
        const keys = TEMPLATES.map((t: any) => t.key);
        for (const k of [
            'promotional_offer', 'weekend_discount', 'holiday', 'referral',
            'driver_appreciation', 'passenger_appreciation', 'safety_notice',
            'service_interruption', 'feature_announcement', 'welcome', 'reactivation',
        ]) {
            expect(keys).toContain(k);
        }
    });

    /*
     * safetyAnnouncements defaults to on and survives an ordinary unsubscribe.
     * A discount carried under it would be reaching people through the one
     * category they cannot leave.
     */
    it('never files a promotion under safety consent', () => {
        for (const t of TEMPLATES) {
            if (t.category === 'safetyAnnouncements') {
                expect(t.key).toMatch(/safety|service_interruption/);
            }
        }
    });

    it('marks driver templates, which the registry currently refuses', () => {
        const driverTemplates = TEMPLATES.filter((t: any) => t.audience === 'driver');
        expect(driverTemplates.length).toBeGreaterThan(0);
        for (const t of driverTemplates) {
            expect(REGISTERED_AUDIENCES.has(t.audience)).toBe(false);
        }
    });

    it('every template has a category and defaults', () => {
        for (const t of TEMPLATES) {
            expect(t.category).toBeTruthy();
            expect(t.defaults.headline).toBeTruthy();
            expect(t.defaults.body).toBeTruthy();
        }
    });
});
