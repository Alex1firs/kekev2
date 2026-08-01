import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from "typeorm";

/**
 * Append-only record of what a staff member did.
 *
 * This is the control the entire Park Dispatch fraud model rests on, so it is
 * written through exactly one service (AuditService) and has no update or
 * delete path anywhere in the application. The existing `audit_log` table stays
 * where it is: it records ROLE-level actions from the shared-key era and is
 * kept as history rather than being rewritten with identities it never had.
 *
 * Two rules about content:
 *  - the actor's roles are SNAPSHOTTED at write time. Resolving them at read
 *    time would rewrite history every time somebody's roles changed;
 *  - `metadata` is minimised and redacted (AuditService.redact) — never a
 *    password, token, hash, OTP or a passenger's full phone number.
 */
@Entity()
@Index(["actorStaffUserId", "createdAt"])
@Index(["action", "createdAt"])
@Index(["resourceType", "resourceId"])
export class StaffAuditEvent {
    @PrimaryGeneratedColumn("uuid")
    id!: string;

    // ── Who ─────────────────────────────────────────────────────────────

    /**
     * The acting staff member, or the sentinel `SYSTEM_LEGACY_ADMIN` for an
     * action taken with the shared API key during the migration window.
     *
     * The sentinel is deliberately not a uuid: it must be impossible to mistake
     * for a person, in a query or on a screen.
     */
    @Index()
    @Column({ type: "varchar" })
    actorStaffUserId!: string;

    /** Roles held at the moment of the action, comma-separated. */
    @Column({ type: "varchar", length: 300, nullable: true })
    actorRoleSnapshot!: string | null;

    /** True when the actor was the legacy shared key rather than a human. */
    @Index()
    @Column({ default: false })
    actorIsLegacy!: boolean;

    // ── What ────────────────────────────────────────────────────────────

    /** Stable SCREAMING_SNAKE verb, e.g. `STAFF_SUSPENDED`, `CONTACT_REVEALED`. */
    @Index()
    @Column({ type: "varchar", length: 80 })
    action!: string;

    @Column({ type: "varchar", length: 60 })
    resourceType!: string;

    @Column({ type: "varchar", nullable: true })
    resourceId!: string | null;

    /** Outcome, so denied attempts are as visible as successful ones. */
    @Index()
    @Column({ type: "varchar", length: 16, default: "success" })
    outcome!: "success" | "denied" | "failure";

    // ── Context (all optional; set the ones that apply) ─────────────────

    @Index()
    @Column({ type: "varchar", nullable: true })
    parkId!: string | null;

    @Index()
    @Column({ type: "varchar", nullable: true })
    rideId!: string | null;

    @Column({ type: "varchar", nullable: true })
    driverId!: string | null;

    @Column({ type: "varchar", nullable: true })
    passengerId!: string | null;

    @Column({ type: "varchar", nullable: true })
    deviceId!: string | null;

    /** Required for the actions listed in AuditService.REASON_REQUIRED_ACTIONS. */
    @Column({ type: "varchar", length: 500, nullable: true })
    reason!: string | null;

    /** Redacted, minimised structured context. */
    @Column({ type: "jsonb", nullable: true })
    metadata!: Record<string, unknown> | null;

    // ── Request provenance ──────────────────────────────────────────────

    @Column({ type: "varchar", length: 64, nullable: true })
    ipAddress!: string | null;

    @Column({ type: "varchar", length: 300, nullable: true })
    userAgent!: string | null;

    /** Ties an audit row to the request log line (index.ts sets `req.requestId`). */
    @Index()
    @Column({ type: "varchar", length: 64, nullable: true })
    correlationId!: string | null;

    @CreateDateColumn()
    createdAt!: Date;
}
