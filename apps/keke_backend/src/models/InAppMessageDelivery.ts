import { Entity, PrimaryGeneratedColumn, Column, Index, CreateDateColumn } from "typeorm";

/**
 * One in-app message's life on one passenger's phone.
 *
 * ── Why in-app needs its own table when push and email do not ────────────
 * Push and email are handed to a provider that reports back. In-app is
 * delivered by KekeRide's own app, so nothing exists to report unless we build
 * it. The four timestamps here are the whole delivery record.
 *
 * ── Displayed is not viewed ──────────────────────────────────────────────
 * `queuedAt`  — chosen for this passenger; the phone has not seen it.
 * `displayedAt` — the app rendered it.
 * `viewedAt`  — it was actually on screen long enough to be read, which the
 *               app decides. A banner that appeared behind a booking sheet was
 *               displayed and not viewed, and reporting those as the same
 *               number would make every in-app campaign look successful.
 * `clickedAt` / `dismissedAt` — what the passenger did about it.
 *
 * ── Nothing writes here yet ──────────────────────────────────────────────
 * The passenger app has no in-app inbox in the released build. The table and
 * the reporting exist so the metric is defined before anybody is tempted to
 * infer it, and the analytics service reports in-app as "not yet instrumented"
 * rather than as zero — those look identical on a chart and mean opposite
 * things.
 */
@Entity()
@Index(["campaignId", "userId"], { unique: true })
@Index(["campaignId", "displayedAt"])
export class InAppMessageDelivery {
    @PrimaryGeneratedColumn("uuid")
    id!: string;

    @Column({ type: "uuid" })
    campaignId!: string;

    @Column()
    userId!: string;

    @CreateDateColumn()
    queuedAt!: Date;

    @Column({ type: "timestamp", nullable: true })
    displayedAt!: Date | null;

    @Column({ type: "timestamp", nullable: true })
    viewedAt!: Date | null;

    @Column({ type: "timestamp", nullable: true })
    clickedAt!: Date | null;

    @Column({ type: "timestamp", nullable: true })
    dismissedAt!: Date | null;

    /** `banner`, `popup` or `inbox` — the same campaign can be shown as any. */
    @Column({ type: "varchar", length: 20, default: "banner" })
    surface!: string;

    /** Which app build reported it, for when a metric turns out to be wrong. */
    @Column({ type: "varchar", length: 40, nullable: true })
    appVersion!: string | null;
}
