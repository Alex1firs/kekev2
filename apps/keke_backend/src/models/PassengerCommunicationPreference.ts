import {
    Entity, PrimaryGeneratedColumn, Column, Index, CreateDateColumn, UpdateDateColumn,
} from "typeorm";

/**
 * What a passenger has agreed to receive.
 *
 * ── Absence means no ─────────────────────────────────────────────────────
 * A missing row is not "unknown, assume yes". It is no. Every existing
 * passenger has no row, because the signup screen never showed terms, a privacy
 * link or a marketing checkbox — they agreed to nothing, so there is nothing to
 * infer. `MarketingConsentService` treats a missing row as opted out and always
 * will; that is the whole safety property of this table.
 *
 * ── Why the categories are separate ──────────────────────────────────────
 * Unsubscribing from offers must not stop a receipt, a password reset or a
 * safety notice. Transactional email is not represented here AT ALL — it is not
 * a preference, it is part of holding an account, and giving it a column would
 * invite somebody to check it.
 *
 * `safetyAnnouncements` defaults true and is the one category a passenger
 * cannot silently lose by unsubscribing from marketing: a service withdrawal or
 * a safety recall is something they need whether or not they want our offers.
 */
@Entity()
@Index(["userId"], { unique: true })
@Index(["marketing"])
export class PassengerCommunicationPreference {
    @PrimaryGeneratedColumn("uuid")
    id!: string;

    @Column()
    userId!: string;

    /**
     * The master marketing switch. False unless the passenger turned it on.
     * Every promotional category is additionally gated on this, so one toggle
     * genuinely stops everything a passenger would call "marketing".
     */
    @Column({ default: false })
    marketing!: boolean;

    /**
     * ── Per channel, because they are different questions ────────────────
     * WHAT somebody wants to hear about and HOW they are willing to be reached
     * are independent. A passenger may take a push notification happily and
     * want no email; SMS is a stronger imposition than either. One switch
     * covering all four cannot honour "email is fine, stop texting me" without
     * making them give up both.
     *
     * Each is additionally gated on `marketing`, so the master switch remains a
     * single honest "stop everything".
     */
    @Column({ default: false })
    marketingEmail!: boolean;

    @Column({ default: false })
    marketingPush!: boolean;

    @Column({ default: false })
    marketingInApp!: boolean;

    /**
     * SMS costs the passenger nothing and KekeRide real money, and is the most
     * intrusive of the four. Never inferred from another channel's consent.
     */
    @Column({ default: false })
    marketingSms!: boolean;

    /** Retained from Phase 1: a content category, not a channel. */
    @Column({ default: false })
    promotionalOffers!: boolean;

    @Column({ default: false })
    productUpdates!: boolean;

    @Column({ default: false })
    surveys!: boolean;

    /** Service withdrawals, safety notices. Opt-out, not opt-in. */
    @Column({ default: true })
    safetyAnnouncements!: boolean;

    /**
     * Where the consent came from, in the passenger's own journey.
     *
     * Recorded because "they opted in" is only a defence if we can say when,
     * how and through which screen. An imported or admin-set consent is
     * deliberately distinguishable from one a passenger gave themselves.
     */
    @Column({ type: "varchar", length: 40, nullable: true })
    consentSource!: string | null;

    @Column({ type: "timestamp", nullable: true })
    consentAt!: Date | null;

    /** The IP the consent was given from, for a disputed opt-in. */
    @Column({ type: "varchar", length: 64, nullable: true })
    consentIp!: string | null;

    @Column({ type: "timestamp", nullable: true })
    unsubscribedAt!: Date | null;

    @Column({ type: "varchar", length: 300, nullable: true })
    unsubscribeReason!: string | null;

    /**
     * Signed token for one-click unsubscribe links.
     *
     * Per-passenger and stable, so a link in an email sent months ago still
     * works — an unsubscribe link that has expired is an unsubscribe link that
     * generates a spam complaint instead.
     */
    @Column({ type: "varchar", length: 64, nullable: true })
    @Index()
    unsubscribeToken!: string | null;

    // ── The one-time prompt ─────────────────────────────────────────────

    /**
     * How many times the prompt has been put in front of this passenger.
     *
     * "Ask once, allow a limited reminder, never nag" cannot be enforced
     * without it: the app would either ask on every launch or never ask again
     * after a single accidental dismissal.
     */
    @Column({ type: "int", default: 0 })
    promptShownCount!: number;

    @Column({ type: "timestamp", nullable: true })
    promptLastShownAt!: Date | null;

    /** Set on accept OR decline. Once set, the prompt is finished forever. */
    @Column({ type: "timestamp", nullable: true })
    promptAnsweredAt!: Date | null;

    /** Which build the consent was given in, for a disputed opt-in. */
    @Column({ type: "varchar", length: 40, nullable: true })
    consentAppVersion!: string | null;

    @CreateDateColumn()
    createdAt!: Date;

    @UpdateDateColumn()
    updatedAt!: Date;
}

/** How a consent decision was reached. */
export const ConsentSource = {
    /** Ticked a box while creating the account. */
    SIGNUP: "signup",
    /** Toggled in the passenger app's own settings. */
    PROFILE: "profile",
    /** Answered a one-time prompt inside the app. */
    IN_APP_PROMPT: "in_app_prompt",
    /** Set by staff, with a reason, on the passenger's spoken request. */
    ADMIN: "admin",
    /** Turned off by the passenger from an email footer. */
    UNSUBSCRIBE_LINK: "unsubscribe_link",
} as const;
