import {
    Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index,
} from 'typeorm';

/**
 * A push destination belonging to a STAFF member, not a customer.
 *
 * Deliberately separate from `DeviceToken`, which is keyed on a customer
 * `User.id` and a `UserRole` that has no dispatcher value, has no `web`
 * platform, and knows nothing about parks or shifts. Overloading it would put
 * two different kinds of identity behind one column and require widening
 * customer auth to accept staff tokens — the separation Phase 1 exists to
 * maintain. See docs/dispatcher_web_push_audit.md §3.
 *
 * One row per (staff member, browser instance). A token is the browser's
 * identity, not the person's: the same dispatcher on two devices has two rows,
 * and a reinstall produces a new token while the old one goes inactive.
 */
export enum StaffDevicePlatform {
    /** A browser using the Web Push / FCM JS SDK. The only one today. */
    WEB = 'web',
    ANDROID = 'android',
    IOS = 'ios',
}

export enum StaffTokenStatus {
    ACTIVE = 'active',
    /** FCM said the token is gone — uninstalled, cleared, or expired. */
    INVALID = 'invalid',
    /** The dispatcher signed out, or the shift ended, or a supervisor revoked it. */
    REVOKED = 'revoked',
}

@Entity()
@Index(['staffUserId', 'status'])
export class StaffDeviceToken {
    @PrimaryGeneratedColumn('uuid')
    id!: string;

    @Index()
    @Column()
    staffUserId!: string;

    /**
     * The FCM registration token.
     *
     * Unique across the table: a browser reporting the same token under a
     * different staff account means the device changed hands, and the old
     * association must end rather than both being kept. Enforced here, not
     * only in application code.
     */
    @Index({ unique: true })
    @Column({ type: 'text' })
    token!: string;

    @Column({ type: 'enum', enum: StaffDevicePlatform, default: StaffDevicePlatform.WEB })
    platform!: StaffDevicePlatform;

    @Column({ type: 'enum', enum: StaffTokenStatus, default: StaffTokenStatus.ACTIVE })
    status!: StaffTokenStatus;

    /**
     * The park this device was registered for.
     *
     * Push is addressed BY PARK — a job arrives at a park, not at a person — so
     * this is what the send path filters on. Null means the device is
     * registered but not yet bound to a park, which cannot receive job alerts.
     */
    @Index()
    @Column({ type: 'varchar', nullable: true })
    parkId!: string | null;

    /** The shift this device registered during, for the audit trail. */
    @Column({ type: 'varchar', nullable: true })
    shiftId!: string | null;

    /**
     * A stable per-browser identifier the client generates and keeps.
     *
     * The FCM token rotates; this does not. It is what lets us say "this is the
     * same tablet as yesterday" when a token changes, and what makes device
     * replacement visible rather than looking like an extra device.
     */
    @Index()
    @Column({ type: 'varchar', nullable: true })
    deviceId!: string | null;

    /** Human label for the diagnostics screen: "Park tablet 1", "Chidi's phone". */
    @Column({ type: 'varchar', length: 120, nullable: true })
    deviceLabel!: string | null;

    /** Reported by the browser. Used only for troubleshooting. */
    @Column({ type: 'varchar', length: 300, nullable: true })
    userAgent!: string | null;

    /** Last time the client re-registered or confirmed this token. */
    @Column({ type: 'timestamp', nullable: true })
    lastSeenAt!: Date | null;

    /** Last push FCM ACCEPTED for this token. Not proof of delivery. */
    @Column({ type: 'timestamp', nullable: true })
    lastPushAcceptedAt!: Date | null;

    /** Last time the service worker on this device acknowledged receiving one. */
    @Column({ type: 'timestamp', nullable: true })
    lastPushReceivedAt!: Date | null;

    /** Last time a notification from this device was actually opened. */
    @Column({ type: 'timestamp', nullable: true })
    lastNotificationOpenedAt!: Date | null;

    @Column({ type: 'varchar', length: 200, nullable: true })
    revokedReason!: string | null;

    @Column({ type: 'timestamp', nullable: true })
    revokedAt!: Date | null;

    @CreateDateColumn()
    createdAt!: Date;

    @UpdateDateColumn()
    updatedAt!: Date;
}
