import {
    Entity, PrimaryGeneratedColumn, Column, Index, CreateDateColumn, UpdateDateColumn,
} from "typeorm";

/**
 * How a lifecycle automation reaches a passenger, and how it is classified.
 *
 * ── Why the consent class lives here and is not editable ────────────────
 * A ride-completed thank-you is a service message; a weekend discount is
 * marketing. If an operator could flip that field, they could send a discount
 * under service consent to somebody who opted out of marketing — which is the
 * one mistake this whole subsystem exists to prevent. The class is seeded by
 * migration and the admin API refuses to change it.
 */
export enum ConsentClass {
    /** Triggered by something that happened to this passenger. No offer. */
    SERVICE = "service",
    /** Unprompted encouragement to transact. Requires explicit consent. */
    MARKETING = "marketing",
}

/**
 * Who an automation may reach.
 *
 * The audience is intersected with the allow-list BEFORE any work is created,
 * never filtered afterwards — see LifecycleAutomationService.audienceFor.
 */
export enum AutomationMode {
    /** Designated internal accounts only. */
    TEST = "TEST",
    /** A named, explicitly approved group. */
    PILOT = "PILOT",
    /** The full eligible audience. */
    PRODUCTION = "PRODUCTION",
}

@Entity()
@Index(["enabled"])
export class CommunicationTrigger {
    @PrimaryGeneratedColumn("uuid")
    id!: string;

    /** Stable identifier used in code and in the dedupe ledger. Never reworded. */
    @Index({ unique: true })
    @Column({ type: "varchar", length: 60 })
    key!: string;

    @Column({ type: "varchar", length: 120 })
    name!: string;

    @Column({ type: "varchar", length: 400, nullable: true })
    description!: string | null;

    /** Immutable after seeding. The admin API rejects attempts to change it. */
    @Column({ type: "varchar", length: 20 })
    consentClass!: ConsentClass;

    /** Channels this automation may use, e.g. ["email","push"]. */
    @Column({ type: "jsonb", default: () => `'[]'::jsonb` })
    channels!: string[];

    @Column({ type: "varchar", length: 60 })
    templateKey!: string;

    /**
     * Ride outcome codes that fire this automation, for ride-driven triggers.
     * Empty for time-driven ones.
     *
     * NO_ELIGIBLE_DRIVER and NO_DRIVER_ACCEPTED both appear here on purpose:
     * to the passenger the outcome is the same, though they remain distinct
     * operational signals and are recorded separately on the dispatch row.
     */
    @Column({ type: "jsonb", default: () => `'[]'::jsonb` })
    triggerCodes!: string[];

    /** Ships false. Enabling one is a deliberate act. */
    @Column({ default: false })
    enabled!: boolean;

    @Column({ type: "varchar", length: 20, default: AutomationMode.TEST })
    mode!: AutomationMode;

    /** Wait before sending, so a thank-you does not arrive mid-payment. */
    @Column({ type: "int", default: 0 })
    delayMinutes!: number;

    /**
     * Minimum gap between two messages from this automation to one passenger.
     *
     * This is what stops five apology emails when somebody presses request five
     * times. Zero means the dedupe key alone governs (one per ride).
     */
    @Column({ type: "int", default: 0 })
    cooldownMinutes!: number;

    /** Ceiling per passenger per window, across occurrences. 0 = no cap. */
    @Column({ type: "int", default: 0 })
    frequencyCap!: number;

    @Column({ type: "int", default: 30 })
    frequencyWindowDays!: number;

    @Column({ type: "jsonb", nullable: true })
    audienceCriteria!: Record<string, unknown> | null;

    @Column({ type: "timestamp", nullable: true })
    lastTriggeredAt!: Date | null;

    @Column({ type: "int", default: 0 })
    sentCount!: number;

    @Column({ type: "int", default: 0 })
    failedCount!: number;

    @CreateDateColumn()
    createdAt!: Date;

    @UpdateDateColumn()
    updatedAt!: Date;
}
