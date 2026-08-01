import { Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from "typeorm";

export enum BadgeStatus {
    /**
     * Printed and handed out, not yet confirmed as reaching the right person.
     * A badge in this state identifies nobody — activation is what proves the
     * physical card and the human are together.
     */
    PENDING_ACTIVATION = "pending_activation",
    ACTIVE = "active",
    REVOKED = "revoked",
    LOST = "lost",
    /** Superseded by a reissue. See replacedByBadgeSerial. */
    REPLACED = "replaced",
}

/**
 * A driver's physical identity card.
 *
 * The badge is an IDENTITY CLAIM, never a credential. A QR code can be
 * photographed from two metres away, so nothing here may unlock a wallet, a
 * profile, a payment reversal or an account. Its entire authority is "assign
 * this ride, to this driver, at this park, by this dispatcher, during this
 * shift" — and every one of those qualifiers is verified server-side at the
 * moment of use.
 *
 * Because of that, the QR payload does not need to be secret. It needs to be
 * unforgeable and revocable, which a truncated HMAC over an opaque id plus a
 * server-side status check gives us. See services/badge_service.ts.
 *
 * Phase 2 issues, activates, revokes and replaces badges. Scanning one to
 * assign a ride is Phase 4.
 */
@Entity()
@Index(["driverId", "status"])
export class DriverBadge {
    /**
     * Human-readable serial printed small on the card edge, e.g. `KR-000042`.
     * The primary key on purpose: it is what a supervisor reads off a physical
     * card when reporting one lost, and a uuid would be useless for that.
     */
    @PrimaryColumn({ type: "varchar", length: 24 })
    badgeSerial!: string;

    @Index()
    @Column()
    driverId!: string;

    /**
     * Opaque per-driver identifier carried in the QR payload.
     *
     * NOT User.id. The internal uuid should not be printed on thousands of
     * paper badges, photographed by anyone who passes, and thereby turned into
     * a public identifier we can never rotate.
     */
    @Index()
    @Column({ type: "varchar", length: 32 })
    driverPublicId!: string;

    /**
     * Six-digit fallback, typed when a badge is unreadable. A lookup key, not a
     * secret: unique among ACTIVE badges, never reused after revocation, and
     * rate-limited at the point of use.
     */
    @Index()
    @Column({ type: "varchar", length: 6 })
    shortCode!: string;

    /** Which signing key version produced this badge's QR signature. */
    @Column({ type: "int", default: 1 })
    keyVersion!: number;

    @Index()
    @Column({ type: "enum", enum: BadgeStatus, default: BadgeStatus.PENDING_ACTIVATION })
    status!: BadgeStatus;

    /** The park this badge was issued for. Null for a park-independent badge. */
    @Index()
    @Column({ type: "varchar", nullable: true })
    parkId!: string | null;

    @Column({ type: "timestamp" })
    issuedAt!: Date;

    @Column({ type: "varchar" })
    issuedByStaffId!: string;

    @Column({ type: "timestamp", nullable: true })
    printedAt!: Date | null;

    @Column({ type: "timestamp", nullable: true })
    activatedAt!: Date | null;

    @Column({ type: "varchar", nullable: true })
    activatedByStaffId!: string | null;

    @Column({ type: "timestamp", nullable: true })
    revokedAt!: Date | null;

    @Column({ type: "varchar", nullable: true })
    revokedByStaffId!: string | null;

    @Column({ type: "varchar", length: 500, nullable: true })
    revokeReason!: string | null;

    @Column({ type: "varchar", length: 24, nullable: true })
    replacedByBadgeSerial!: string | null;

    @CreateDateColumn()
    createdAt!: Date;

    @UpdateDateColumn()
    updatedAt!: Date;
}
