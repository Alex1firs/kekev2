import { Entity, PrimaryGeneratedColumn, Column, Index, CreateDateColumn } from "typeorm";

/**
 * One delivery event as the provider sent it.
 *
 * ── Why the raw event is kept ────────────────────────────────────────────
 * A bounce suppresses an address permanently. When somebody later asks why
 * they stopped receiving mail, "the provider told us" is only an answer if the
 * exact thing the provider told us is still readable. The parsed consequence
 * lives on the recipient row; this is the evidence for it.
 *
 * ── The unique id is the whole idempotency story ─────────────────────────
 * Svix retries. It retries on a timeout, on a 500, and on a deploy that
 * happened to restart the container mid-request — so the same event arrives
 * two, five, occasionally a dozen times. `svixId` is unique, so a repeat is
 * refused by the database rather than by a check that might have raced with
 * the retry it was meant to catch. Opens and clicks are counted, and counting
 * the same open eight times would make a campaign report fiction.
 */
@Entity()
@Index(["svixId"], { unique: true })
@Index(["type", "createdAt"])
@Index(["providerMessageId"])
export class EmailWebhookEvent {
    @PrimaryGeneratedColumn("uuid")
    id!: string;

    /** The provider's delivery id for this webhook attempt. Unique. */
    @Column({ type: "varchar", length: 120 })
    svixId!: string;

    /** `email.delivered`, `email.bounced`, and so on, verbatim. */
    @Column({ type: "varchar", length: 80 })
    type!: string;

    /** Ties the event to an EmailCampaignRecipient. Null for unmatched mail. */
    @Column({ type: "varchar", nullable: true })
    providerMessageId!: string | null;

    @Column({ type: "varchar", nullable: true })
    email!: string | null;

    /** The event exactly as received, after signature verification. */
    @Column({ type: "jsonb" })
    payload!: Record<string, unknown>;

    /**
     * What we did about it, in a few words. Null while unprocessed.
     *
     * An event we could not act on — transactional mail, an address with no
     * campaign row — is still stored, with the reason. Silence would be
     * indistinguishable from a bug.
     */
    @Column({ type: "varchar", length: 300, nullable: true })
    outcome!: string | null;

    @Column({ type: "timestamp", nullable: true })
    processedAt!: Date | null;

    @CreateDateColumn()
    createdAt!: Date;
}
