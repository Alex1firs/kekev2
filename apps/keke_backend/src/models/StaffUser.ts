import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from "typeorm";

/**
 * Operational lifecycle of a staff account.
 *
 * Only ACTIVE grants any permission at all. Every other state resolves to an
 * empty permission set — see StaffAuthService.resolvePermissions.
 */
export enum StaffStatus {
    /** Created, credentials not yet set. Cannot log in. */
    INVITED = "invited",
    /** Normal working state. */
    ACTIVE = "active",
    /** Temporarily barred by repeated failed logins. Self-clears at lockedUntil. */
    LOCKED = "locked",
    /** Deliberately barred by an administrator. Reversible. */
    SUSPENDED = "suspended",
    /** Permanently retired. Never reactivated — the audit trail keeps pointing here. */
    DEACTIVATED = "deactivated",
}

/**
 * A human who works for KekeRide.
 *
 * Deliberately NOT the `user` table. Staff need MFA, device binding, shifts,
 * credential rotation and suspension that customers do not; and a defect in
 * customer authentication must not be able to reach staff privileges. The two
 * identity systems are signed with different secrets and different token
 * audiences (see StaffAuthService), so a customer token is not merely rejected
 * by policy — it fails signature verification.
 *
 * No plaintext credential is ever stored. `passwordHash` is bcrypt; setup and
 * reset happen through single-use, hashed, expiring invitation tokens
 * (`setupTokenHash`), never through a reusable temporary password.
 */
@Entity()
export class StaffUser {
    @PrimaryGeneratedColumn("uuid")
    id!: string;

    @Index({ unique: true })
    @Column()
    email!: string;

    /**
     * Normalised to bare international digits (2348012345678) by
     * AuthService.normalizePhone, so one human cannot hold two accounts under
     * `0801…` and `+234801…`.
     */
    @Index({ unique: true })
    @Column({ type: "varchar", length: 32 })
    phone!: string;

    @Column()
    firstName!: string;

    @Column()
    lastName!: string;

    /** bcrypt. Null while INVITED — an account with no credential cannot log in. */
    @Column({ type: "varchar", nullable: true })
    passwordHash!: string | null;

    @Index()
    @Column({ type: "enum", enum: StaffStatus, default: StaffStatus.INVITED })
    status!: StaffStatus;

    // ── Credential lifecycle ────────────────────────────────────────────

    /**
     * Bumped by every credential reset, password change, suspension and role
     * change. Every issued token carries the value that was current when it was
     * minted; a token whose version is behind the account's is rejected.
     *
     * This is what makes "reset invalidates existing sessions" true without a
     * session lookup on the hot path.
     */
    @Column({ type: "int", default: 1 })
    credentialVersion!: number;

    @Column({ type: "timestamp", nullable: true })
    lastPasswordChangeAt!: Date | null;

    /** SHA-256 of a single-use setup/reset token. The token itself is never stored. */
    @Column({ type: "varchar", nullable: true })
    setupTokenHash!: string | null;

    @Column({ type: "timestamp", nullable: true })
    setupTokenExpiresAt!: Date | null;

    // ── Sign-in state ───────────────────────────────────────────────────

    @Column({ type: "timestamp", nullable: true })
    lastLoginAt!: Date | null;

    @Column({ type: "int", default: 0 })
    failedLoginCount!: number;

    /** Set by lockout. A login attempt before this instant is refused outright. */
    @Column({ type: "timestamp", nullable: true })
    lockedUntil!: Date | null;

    // ── Suspension ──────────────────────────────────────────────────────

    @Column({ type: "timestamp", nullable: true })
    suspendedAt!: Date | null;

    /** The StaffUser.id who suspended this account. */
    @Column({ type: "varchar", nullable: true })
    suspendedBy!: string | null;

    @Column({ type: "varchar", length: 500, nullable: true })
    suspensionReason!: string | null;

    // ── MFA ─────────────────────────────────────────────────────────────
    // Fields exist now so enrolment can be added without a second migration on
    // a table that will by then hold real staff. Enforcement lands with the
    // roles that require it (see docs/staff_identity_architecture.md).

    @Column({ default: false })
    mfaEnabled!: boolean;

    /** Encrypted TOTP secret. Null until enrolment. Never returned by any API. */
    @Column({ type: "varchar", nullable: true })
    mfaSecret!: string | null;

    @Column({ type: "timestamp", nullable: true })
    mfaEnrolledAt!: Date | null;

    // ── Provenance ──────────────────────────────────────────────────────

    /** The StaffUser.id who created this account. Null for the bootstrap account. */
    @Column({ type: "varchar", nullable: true })
    createdByStaffId!: string | null;

    @CreateDateColumn()
    createdAt!: Date;

    @UpdateDateColumn()
    updatedAt!: Date;
}
