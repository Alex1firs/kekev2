import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from "typeorm";

/**
 * A record that somebody was shown another person's real contact details.
 *
 * Distinct from StaffAuditEvent on purpose. A reveal is not only an action to
 * attribute, it is a GRANT with a lifetime: it answers "who may currently see
 * this passenger's number, and until when". Keeping it as its own row makes
 * expiry queryable and makes a contact-exposure report a single table scan
 * rather than a filter over every audit row ever written.
 *
 * Both staff reveals and driver assignment-time access land here, so there is
 * one place that answers "who has seen this number".
 */
export enum ContactRevealActorType {
    /** A staff member with ride:reveal_contact or dispatch:reveal_passenger_contact. */
    STAFF = "staff",
    /** The driver actually assigned to the ride, at assignment time. */
    ASSIGNED_DRIVER = "assigned_driver",
    /** The legacy shared admin key. Recorded, never named as a human. */
    LEGACY_ADMIN = "legacy_admin",
}

export enum ContactSubjectRole {
    PASSENGER = "passenger",
    DRIVER = "driver",
}

@Entity()
@Index(["rideId", "createdAt"])
@Index(["actorId", "createdAt"])
export class ContactRevealEvent {
    @PrimaryGeneratedColumn("uuid")
    id!: string;

    @Index()
    @Column({ type: "varchar", nullable: true })
    rideId!: string | null;

    @Column({ type: "enum", enum: ContactRevealActorType })
    actorType!: ContactRevealActorType;

    /** StaffUser.id, driver User.id, or the SYSTEM_LEGACY_ADMIN sentinel. */
    @Index()
    @Column({ type: "varchar" })
    actorId!: string;

    /** Whose contact was revealed. */
    @Column({ type: "varchar" })
    subjectUserId!: string;

    @Column({ type: "enum", enum: ContactSubjectRole })
    subjectRole!: ContactSubjectRole;

    /** Which fields were shown, e.g. `phone`, `firstName`. Never the values. */
    @Column({ type: "varchar", length: 200 })
    fields!: string;

    /** Required for staff reveals; the operational justification. */
    @Column({ type: "varchar", length: 500, nullable: true })
    reason!: string | null;

    /**
     * When this grant lapses. The client must not cache the value beyond it,
     * and a re-read after expiry produces a NEW reveal event — so a long-lived
     * incident shows up as repeated, deliberate access rather than one look.
     */
    @Index()
    @Column({ type: "timestamp" })
    expiresAt!: Date;

    @Column({ type: "varchar", nullable: true })
    deviceId!: string | null;

    @Column({ type: "varchar", length: 64, nullable: true })
    ipAddress!: string | null;

    @Column({ type: "varchar", length: 64, nullable: true })
    correlationId!: string | null;

    @CreateDateColumn()
    createdAt!: Date;
}
