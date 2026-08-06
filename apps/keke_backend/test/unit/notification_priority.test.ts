/**
 * Priority, and the rule that marketing always yields.
 *
 * This is the classification the whole platform routes on, so the tests are
 * about the boundary being impossible to cross rather than about lookups
 * returning the right value.
 */

import {
    NotificationPriority, priorityOf, isMarketing, mustYieldTo,
    fcmPriority, androidChannel,
} from '../../src/services/notification_priority';

describe('priority 1 — somebody is waiting, stranded or in danger', () => {
    it.each([
        'NEW_REQUEST', 'RIDE_ASSIGNED', 'DRIVER_ASSIGNED', 'OTP',
        'PASSWORD_RESET', 'PAYMENT_CONFIRMATION', 'SOS', 'SAFETY_ALERT',
    ])('%s is CRITICAL', (kind) => {
        expect(priorityOf(kind)).toBe(NotificationPriority.CRITICAL);
    });
});

describe('priority 2 — operationally necessary', () => {
    it.each([
        'RIDE_ARRIVED', 'TRIP_UPDATE', 'DRIVER_ARRIVAL', 'RECEIPT',
        'OPERATIONAL_ANNOUNCEMENT',
    ])('%s is OPERATIONAL', (kind) => {
        expect(priorityOf(kind)).toBe(NotificationPriority.OPERATIONAL);
    });
});

describe('priority 3 — marketing', () => {
    it.each(['PROMOTION', 'MARKETING_CAMPAIGN', 'NEWSLETTER', 'PRODUCT_ANNOUNCEMENT'])(
        '%s is MARKETING', (kind) => {
            expect(priorityOf(kind)).toBe(NotificationPriority.MARKETING);
            expect(isMarketing(kind)).toBe(true);
        });
});

describe('the yielding rule', () => {
    it('marketing yields to both higher priorities', () => {
        expect(mustYieldTo('PROMOTION', NotificationPriority.CRITICAL)).toBe(true);
        expect(mustYieldTo('PROMOTION', NotificationPriority.OPERATIONAL)).toBe(true);
    });

    /*
     * One-directional by design. There is no argument a campaign can make for
     * going first, and no configuration that reverses this.
     */
    it('nothing yields to marketing', () => {
        for (const kind of ['NEW_REQUEST', 'SOS', 'OTP', 'RIDE_ARRIVED', 'RECEIPT']) {
            expect(mustYieldTo(kind, NotificationPriority.MARKETING)).toBe(false);
        }
    });

    /*
     * An unclassified message delivered promptly is a small waste. An
     * unclassified ride alert throttled behind a promotion is the failure this
     * default exists to prevent.
     */
    it('an unknown kind is treated as CRITICAL, never as marketing', () => {
        expect(priorityOf('SOMETHING_NEW')).toBe(NotificationPriority.CRITICAL);
        expect(priorityOf(undefined)).toBe(NotificationPriority.CRITICAL);
        expect(priorityOf(null)).toBe(NotificationPriority.CRITICAL);
        expect(isMarketing('SOMETHING_NEW')).toBe(false);
    });
});

describe('delivery characteristics', () => {
    it('sends marketing at normal FCM priority and everything else high', () => {
        expect(fcmPriority('PROMOTION')).toBe('normal');
        expect(fcmPriority('NEW_REQUEST')).toBe('high');
        expect(fcmPriority('SOS')).toBe('high');
    });

    /*
     * Marketing gets its own Android channel so a passenger who mutes
     * promotions in system settings does not thereby mute ride alerts.
     */
    it('routes marketing to its own Android channel, never a ride channel', () => {
        expect(androidChannel('PROMOTION')).toBe('keke_promotions');
        expect(androidChannel('MARKETING_CAMPAIGN')).toBe('keke_promotions');
        expect(androidChannel('NEW_REQUEST')).toBe('keke_ride_requests');
        expect(androidChannel('RIDE_ASSIGNED')).toBe('keke_ride_updates');

        for (const kind of ['PROMOTION', 'NEWSLETTER', 'MARKETING_CAMPAIGN']) {
            expect(androidChannel(kind)).not.toBe('keke_ride_requests');
            expect(androidChannel(kind)).not.toBe('keke_ride_updates');
        }
    });
});

describe('the operational path is not coupled to marketing', () => {
    /*
     * Structural, not conditional: NotificationService must not be able to read
     * the health monitor back, or a monitoring problem could delay a ride alert.
     */
    it('NotificationService records health but never reads it', () => {
        const source = require('fs').readFileSync(
            require('path').join(__dirname, '../../src/services/notification_service.ts'), 'utf8');

        expect(source).toMatch(/OperationalPushHealth\.record/);
        expect(source).not.toMatch(/marketingMayRun/);
        expect(source).not.toMatch(/OperationalPushHealth\.health/);
        // And it knows nothing about campaigns at all.
        expect(source).not.toMatch(/MarketingPushService|MarketingPushJob|campaign/i);
    });

    it('the marketing sender never imports the operational sender', () => {
        const source = require('fs').readFileSync(
            require('path').join(__dirname, '../../src/services/marketing_push_service.ts'), 'utf8');
        expect(source).not.toMatch(/from '\.\/notification_service'/);
        expect(source).not.toMatch(/NotificationService/);
    });
});
