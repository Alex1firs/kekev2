/**
 * Who KekeRide can address, and what each audience costs to add.
 *
 * ── Why a registry rather than a switch statement ────────────────────────
 * Every audience differs in exactly four ways: which rows it selects, which
 * consent record governs it, which channels can physically reach it, and who is
 * allowed to send to it. Everything else — campaigns, approval, scheduling,
 * queues, suppression, reporting, the emergency stop — is already shared.
 *
 * Naming those four things here turns "support drivers" into filling in one
 * entry, instead of a change that touches the audience query, the consent
 * service, the eligibility check, the send path and four screens.
 *
 * ── Only passengers are enabled, and that is a decision, not a gap ───────
 * Every other audience has `enabled: false` and lists what is missing. The
 * resolver refuses them rather than falling through, because a driver has no
 * consent record and reaching them would mean marketing to somebody who never
 * agreed. Flipping a flag here is the LAST step of adding an audience, not the
 * first — the prerequisites listed on each entry have to exist first.
 *
 * ── Most driver and staff messaging is not marketing ─────────────────────
 * "Your badge expires Friday" is operational: it belongs in
 * NOTIFICATION_PRIORITY at P2 and goes out through NotificationService with no
 * consent gate, no campaign and no approval, because it is part of the service
 * they signed up to. Only genuine promotion needs this machinery. Routing
 * operational driver messages through the marketing queue would make them
 * pausable, throttled and last in line — a driver would learn their shift
 * changed some minutes after the fact.
 */

export type AudienceType =
    | 'passenger' | 'driver' | 'dispatcher' | 'supervisor' | 'staff' | 'partner';

export interface AudienceDefinitionEntry {
    type: AudienceType;
    label: string;
    /** One line an admin reads on the audience picker. */
    description: string;
    /** Can a campaign be addressed to this audience today? */
    enabled: boolean;
    /** Which table the members come from. */
    source: 'user' | 'staff_user' | 'external';
    /** The consent record governing marketing to them, once one exists. */
    consentModel: string | null;
    /** Channels that could physically reach them. */
    channels: Array<'email' | 'push' | 'in_app' | 'sms'>;
    /** What must exist before `enabled` may become true. */
    prerequisites: string[];
    /**
     * Whether most messaging to this audience is operational rather than
     * marketing. Shown on the picker so nobody builds a campaign for something
     * that should be a P2 notification.
     */
    mostlyOperational: boolean;
}

export const AUDIENCE_REGISTRY: Record<AudienceType, AudienceDefinitionEntry> = {
    passenger: {
        type: 'passenger',
        label: 'Passengers',
        description: 'People who book rides. The only audience with a consent record and an opt-in flow.',
        enabled: true,
        source: 'user',
        consentModel: 'PassengerCommunicationPreference',
        channels: ['email', 'push', 'in_app', 'sms'],
        prerequisites: [],
        mostlyOperational: false,
    },

    driver: {
        type: 'driver',
        label: 'Drivers',
        description: 'Keke operators. Reachable for genuine promotion only — referral bonuses, incentives.',
        enabled: false,
        source: 'user',
        consentModel: null,
        channels: ['push', 'sms', 'in_app'],
        prerequisites: [
            'A DriverCommunicationPreference table — a separate record, not a nullable column on the passenger one: different lawful basis, different retention.',
            'An opt-in surface in the driver app, unticked by default.',
            'A decision on whether a driver can decline marketing without affecting dispatch. (They can. It must be written down.)',
        ],
        mostlyOperational: true,
    },

    dispatcher: {
        type: 'dispatcher',
        label: 'Dispatchers',
        description: 'Park dispatch staff. Almost everything they need is operational and already delivered.',
        enabled: false,
        source: 'staff_user',
        consentModel: null,
        channels: ['push', 'in_app'],
        prerequisites: [
            'A staff notification preference record.',
            'A clear line between "internal announcement" and "marketing" — most of this is neither, and belongs in the dispatcher workspace rather than a campaign.',
        ],
        mostlyOperational: true,
    },

    supervisor: {
        type: 'supervisor',
        label: 'Park supervisors',
        description: 'Park-level management. Operational bulletins, roster changes, policy updates.',
        enabled: false,
        source: 'staff_user',
        consentModel: null,
        channels: ['email', 'push'],
        prerequisites: [
            'A staff notification preference record.',
            'Park-scoped audience filters, so a bulletin for one park does not reach every supervisor.',
        ],
        mostlyOperational: true,
    },

    staff: {
        type: 'staff',
        label: 'Staff',
        description: 'Everyone with a StaffUser account. Internal announcements.',
        enabled: false,
        source: 'staff_user',
        consentModel: null,
        channels: ['email', 'in_app'],
        prerequisites: [
            'A staff notification preference record.',
            'Consent is not the gate here — employment is. That difference has to be reflected in the eligibility check rather than reusing the passenger one.',
        ],
        mostlyOperational: true,
    },

    partner: {
        type: 'partner',
        label: 'Partners',
        description: 'Organisations rather than people — fleet owners, corporate accounts, park associations.',
        enabled: false,
        source: 'external',
        consentModel: null,
        channels: ['email'],
        prerequisites: [
            'A Partner entity. None exists; partners are currently informal relationships with no record in the system.',
            'A contact model, since a partner is an organisation with several people at it — the one place where "audience member" is not "one user row".',
        ],
        mostlyOperational: false,
    },
};

/** The audiences a campaign may actually be addressed to today. */
export const REGISTERED_AUDIENCES: ReadonlySet<AudienceType> = new Set<AudienceType>(
    (Object.values(AUDIENCE_REGISTRY) as AudienceDefinitionEntry[])
        .filter((a) => a.enabled)
        .map((a) => a.type),
);

export function audienceEntry(type: AudienceType | undefined | null): AudienceDefinitionEntry {
    return AUDIENCE_REGISTRY[(type ?? 'passenger') as AudienceType] ?? AUDIENCE_REGISTRY.passenger;
}

/**
 * Throw unless this audience can be resolved.
 *
 * The message names the missing prerequisite rather than saying "unsupported",
 * because the person who hits this is usually about to go and build it.
 */
export function assertAudienceAvailable(type: AudienceType): void {
    const entry = AUDIENCE_REGISTRY[type];
    if (!entry) {
        throw new Error(`Unknown audience "${type}".`);
    }
    if (!entry.enabled) {
        throw new Error(
            `The "${entry.label}" audience is not available yet. Still needed: `
            + entry.prerequisites.join(' ')
        );
    }
}

/** The audience picker's data, enabled first. */
export function audienceOptions() {
    return (Object.values(AUDIENCE_REGISTRY) as AudienceDefinitionEntry[])
        .sort((a, b) => Number(b.enabled) - Number(a.enabled))
        .map((a) => ({
            type: a.type,
            label: a.label,
            description: a.description,
            enabled: a.enabled,
            channels: a.channels,
            mostlyOperational: a.mostlyOperational,
            prerequisites: a.prerequisites,
        }));
}
