/**
 * What every notification KekeRide sends is worth, relative to the others.
 *
 * ── Why one table for the whole platform ─────────────────────────────────
 * This is the permanent classification. Every message — operational or
 * marketing, push or email or SMS — resolves to one of three priorities here,
 * so there is exactly one place that answers "may this yield to that". A second
 * opinion living in the marketing sender would eventually disagree with this
 * one, and the disagreement would be discovered when a promotion delayed a ride
 * alert.
 *
 * ── The rule ─────────────────────────────────────────────────────────────
 * P3 yields to P1 and P2, always. Nothing yields to P3. There is no
 * configuration that reverses this and no priority a campaign can be given that
 * lifts it above operational traffic — a marketing message is never more
 * important than a passenger finding their driver.
 */

export enum NotificationPriority {
    /**
     * Somebody is waiting, stranded, locked out or in danger. Never delayed,
     * never throttled, never batched behind anything.
     */
    CRITICAL = 1,
    /** Operationally necessary. Delivered promptly; may queue behind P1. */
    OPERATIONAL = 2,
    /** Marketing. Yields to everything, always. */
    MARKETING = 3,
}

/**
 * Message kinds, and what each is worth.
 *
 * Adding a kind means deciding its priority here rather than at the call site,
 * so the decision is reviewable in one diff and cannot be quietly promoted by
 * whoever is writing the feature.
 */
export const NOTIFICATION_PRIORITY: Record<string, NotificationPriority> = {
    // ── Priority 1 ──────────────────────────────────────────────────────
    NEW_REQUEST: NotificationPriority.CRITICAL,
    RIDE_ASSIGNED: NotificationPriority.CRITICAL,
    DRIVER_ASSIGNED: NotificationPriority.CRITICAL,
    /** Operations gave a driver a trip by hand. They are not watching for it. */
    TRIP_ASSIGNED: NotificationPriority.CRITICAL,
    OTP: NotificationPriority.CRITICAL,
    EMAIL_VERIFICATION: NotificationPriority.CRITICAL,
    PASSWORD_RESET: NotificationPriority.CRITICAL,
    PAYMENT_CONFIRMATION: NotificationPriority.CRITICAL,
    SOS: NotificationPriority.CRITICAL,
    SAFETY_ALERT: NotificationPriority.CRITICAL,

    // ── Priority 2 ──────────────────────────────────────────────────────
    RIDE_ARRIVED: NotificationPriority.OPERATIONAL,
    TRIP_STARTED: NotificationPriority.OPERATIONAL,
    TRIP_UPDATE: NotificationPriority.OPERATIONAL,
    DRIVER_ARRIVAL: NotificationPriority.OPERATIONAL,
    RECEIPT: NotificationPriority.OPERATIONAL,
    RIDE_COMPLETED: NotificationPriority.OPERATIONAL,
    OPERATIONAL_ANNOUNCEMENT: NotificationPriority.OPERATIONAL,
    MAINTENANCE_NOTICE: NotificationPriority.OPERATIONAL,
    DISPATCH_NOTIFICATION: NotificationPriority.OPERATIONAL,

    // ── Priority 3 ──────────────────────────────────────────────────────
    PROMOTION: NotificationPriority.MARKETING,
    MARKETING_CAMPAIGN: NotificationPriority.MARKETING,
    NEWSLETTER: NotificationPriority.MARKETING,
    PRODUCT_ANNOUNCEMENT: NotificationPriority.MARKETING,
    SURVEY: NotificationPriority.MARKETING,
};

/**
 * The priority of a message kind.
 *
 * An unknown kind is treated as CRITICAL, not as marketing. Getting this wrong
 * in the safe direction means an unclassified message is delivered promptly;
 * getting it wrong the other way means a ride alert silently throttled behind a
 * promotion, which is the failure worth being paranoid about.
 */
export function priorityOf(kind: string | undefined | null): NotificationPriority {
    if (!kind) return NotificationPriority.CRITICAL;
    return NOTIFICATION_PRIORITY[kind] ?? NotificationPriority.CRITICAL;
}

export function isMarketing(kind: string | undefined | null): boolean {
    return priorityOf(kind) === NotificationPriority.MARKETING;
}

/**
 * Whether `kind` must give way to traffic at `other`.
 *
 * Deliberately one-directional: P3 yields to P1 and P2, and nothing yields to
 * P3. There is no argument a campaign can make for going first.
 */
export function mustYieldTo(kind: string, other: NotificationPriority): boolean {
    return priorityOf(kind) === NotificationPriority.MARKETING
        && other <= NotificationPriority.OPERATIONAL;
}

/** FCM delivery priority. Marketing is normal; everything else is high. */
export function fcmPriority(kind: string): 'high' | 'normal' {
    return isMarketing(kind) ? 'normal' : 'high';
}

/**
 * The Android channel a message belongs on.
 *
 * Marketing gets its OWN channel, which is the point: a passenger who mutes
 * promotions in Android's settings must not thereby mute ride alerts, and a
 * marketing message must never be routed onto the high-importance channel that
 * makes a phone ring for a waiting passenger.
 */
export function androidChannel(kind: string): string | undefined {
    if (isMarketing(kind)) return 'keke_promotions';
    if (kind === 'NEW_REQUEST') return 'keke_ride_requests';
    if (kind === 'RIDE_ASSIGNED' || kind === 'RIDE_ARRIVED') return 'keke_ride_updates';
    return undefined;
}
