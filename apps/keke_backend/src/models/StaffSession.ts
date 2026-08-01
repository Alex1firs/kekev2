import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from "typeorm";

/**
 * One staff sign-in.
 *
 * Access tokens are short-lived and stateless; this row exists so a session can
 * be revoked *individually* (this laptop, not every device) and so "where was
 * this account signed in from" is answerable. The refresh token is stored only
 * as a SHA-256 hash — a database read must not yield a usable credential.
 *
 * Two revocation mechanisms, on purpose:
 *  - per-session:  `revokedAt` on this row (logout, admin kills one session);
 *  - account-wide: `credentialVersion` on StaffUser (password reset, suspension,
 *    role change) — no session lookup needed, so it cannot be missed.
 */
@Entity()
@Index(["staffUserId", "revokedAt"])
export class StaffSession {
    @PrimaryGeneratedColumn("uuid")
    id!: string;

    @Index()
    @Column()
    staffUserId!: string;

    /** SHA-256 of the refresh token. The token itself is never persisted. */
    @Index()
    @Column({ type: "varchar" })
    refreshTokenHash!: string;

    /**
     * The account's credentialVersion when this session was created. A session
     * whose version is behind the account's is dead, whatever `revokedAt` says.
     */
    @Column({ type: "int", default: 1 })
    credentialVersion!: number;

    /** Bound park device, once Phase 2 introduces them. Null for browser sessions. */
    @Column({ type: "varchar", nullable: true })
    deviceId!: string | null;

    @CreateDateColumn()
    issuedAt!: Date;

    @Column({ type: "timestamp" })
    expiresAt!: Date;

    @Column({ type: "timestamp", nullable: true })
    lastUsedAt!: Date | null;

    @Index()
    @Column({ type: "timestamp", nullable: true })
    revokedAt!: Date | null;

    /** e.g. `logout`, `credential_reset`, `suspended`, `superseded_by_new_login`. */
    @Column({ type: "varchar", length: 64, nullable: true })
    revokedReason!: string | null;

    @Column({ type: "varchar", length: 64, nullable: true })
    ipAddress!: string | null;

    @Column({ type: "varchar", length: 300, nullable: true })
    userAgent!: string | null;
}
