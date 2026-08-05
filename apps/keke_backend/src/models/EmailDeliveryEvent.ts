import { Entity, PrimaryGeneratedColumn, Column, Index, CreateDateColumn } from "typeorm";

/**
 * A provider event about one message.
 *
 * ── Idempotent by construction ───────────────────────────────────────────
 * Providers retry webhooks. Resend will deliver the same event more than once
 * on any doubt about our response, and a redelivered "complaint" that
 * incremented a counter twice would misreport a campaign — or worse, a
 * redelivered "opened" would inflate the only number anyone reads.
 *
 * `providerEventId` is unique, so a repeat insert is refused by the database.
 * Where a provider sends no event id we derive one from (messageId, type,
 * timestamp), which is stable for the same event and different for a real
 * second one.
 */
@Entity()
@Index(["providerEventId"], { unique: true })
@Index(["campaignId", "type"])
@Index(["recipientId"])
export class EmailDeliveryEvent {
    @PrimaryGeneratedColumn("uuid")
    id!: string;

    @Column({ type: "varchar", length: 200 })
    providerEventId!: string;

    @Column({ type: "varchar", nullable: true })
    campaignId!: string | null;

    @Column({ type: "varchar", nullable: true })
    recipientId!: string | null;

    @Column({ type: "varchar", nullable: true })
    providerMessageId!: string | null;

    @Column({ type: "varchar", length: 40 })
    type!: string;

    /** The provider's payload, minus anything we would not want to keep. */
    @Column({ type: "jsonb", nullable: true })
    payload!: Record<string, unknown> | null;

    /** When the provider says it happened, not when we stored it. */
    @Column({ type: "timestamp", nullable: true })
    occurredAt!: Date | null;

    @CreateDateColumn()
    createdAt!: Date;
}
