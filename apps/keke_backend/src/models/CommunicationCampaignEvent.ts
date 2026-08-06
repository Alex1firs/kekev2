import { Entity, PrimaryGeneratedColumn, Column, Index, CreateDateColumn } from "typeorm";

/**
 * Everything that ever happened to a campaign, permanently.
 *
 * ── Why not reuse the staff audit log ────────────────────────────────────
 * StaffAuditEvent answers "what did this person do", across the whole
 * platform. This answers "what happened to this campaign", which is a
 * different question asked by different people at different times — usually
 * months later, by somebody holding a complaint and wanting to know who
 * approved the thing that caused it.
 *
 * Both are written. The audit log is the staff-accountability record and is
 * retained under its own policy; this is part of the campaign, and is never
 * pruned while the campaign exists.
 *
 * ── Append-only ──────────────────────────────────────────────────────────
 * Nothing updates or deletes a row here. A campaign's history that could be
 * edited would be worth exactly as much as no history at all, so the service
 * exposes `record()` and reads, and nothing else.
 *
 * ── The diff is stored, not recomputed ───────────────────────────────────
 * `changes` holds before/after for the fields that actually moved. Working it
 * out later from surrounding rows is impossible once a template has been
 * edited or a staff member deleted, and "the subject line changed" is not an
 * answer when somebody needs to know what it changed FROM.
 */
@Entity()
@Index(["campaignId", "createdAt"])
@Index(["action", "createdAt"])
export class CommunicationCampaignEvent {
    @PrimaryGeneratedColumn("uuid")
    id!: string;

    @Column({ type: "uuid" })
    campaignId!: string;

    /** `created`, `edited`, `approved`, `cancelled`, `paused`, `resumed`, … */
    @Column({ type: "varchar", length: 40 })
    action!: string;

    /**
     * Who did it. Null only for the scheduler and the send workers, which act
     * on a decision a human already made and recorded above them.
     */
    @Column({ type: "varchar", nullable: true })
    actorStaffId!: string | null;

    /** Copied at the time. A staff member who leaves must not erase the record. */
    @Column({ type: "varchar", length: 160, nullable: true })
    actorName!: string | null;

    @Column({ type: "varchar", length: 80, nullable: true })
    actorRole!: string | null;

    /** Which channel, when the action was about one. */
    @Column({ type: "varchar", length: 30, nullable: true })
    channel!: string | null;

    /** Free text the actor gave — a cancellation reason, an approval note. */
    @Column({ type: "varchar", length: 500, nullable: true })
    note!: string | null;

    /** `[{ field, from, to }]`. Empty for actions that changed no field. */
    @Column({ type: "jsonb", nullable: true })
    changes!: Array<{ field: string; from: unknown; to: unknown }> | null;

    @Column({ type: "varchar", length: 60, nullable: true })
    ipAddress!: string | null;

    @Column({ type: "varchar", length: 300, nullable: true })
    userAgent!: string | null;

    @CreateDateColumn()
    createdAt!: Date;
}
