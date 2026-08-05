import { Entity, PrimaryGeneratedColumn, Column, Index, CreateDateColumn } from "typeorm";

/**
 * Addresses that must never receive marketing again.
 *
 * ── Keyed on the address, not the passenger ──────────────────────────────
 * A bounce or a complaint arrives from the provider carrying an email address
 * and nothing else. Keying this on userId would mean resolving an address back
 * to an account before we could honour it — and failing to, for an address that
 * has since been changed or that belongs to a deleted account, which is exactly
 * the case where continuing to send is most damaging.
 *
 * The address is stored lowercased and is unique, so recording the same
 * complaint twice is a no-op rather than a second row.
 *
 * ── This never blocks transactional email ────────────────────────────────
 * A hard bounce is a fact about deliverability, not a preference, so a bounced
 * address still gets its password-reset code — the send will simply fail again,
 * which is correct. Only the marketing path consults this table.
 */
@Entity()
@Index(["email"], { unique: true })
@Index(["reason", "createdAt"])
export class EmailSuppression {
    @PrimaryGeneratedColumn("uuid")
    id!: string;

    /** Always lowercased by SuppressionService before it reaches here. */
    @Column()
    email!: string;

    @Column({ type: "enum", enum: ["hard_bounce", "complaint", "unsubscribe", "manual", "invalid"] })
    reason!: "hard_bounce" | "complaint" | "unsubscribe" | "manual" | "invalid";

    /**
     * Who or what added it: a provider webhook, an admin, or our own validation.
     * A manual suppression that nobody can attribute is one nobody dares remove.
     */
    @Column({ type: "varchar", length: 40 })
    source!: string;

    /** The provider's own words, where it gave any. */
    @Column({ type: "varchar", length: 500, nullable: true })
    detail!: string | null;

    /** Set when a person added or removed it by hand. */
    @Column({ type: "varchar", nullable: true })
    createdByStaffId!: string | null;

    /** The campaign that produced the bounce, when there was one. */
    @Column({ type: "varchar", nullable: true })
    campaignId!: string | null;

    @CreateDateColumn()
    createdAt!: Date;
}
