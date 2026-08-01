import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

/**
 * What actually happened to one dispatcher push.
 *
 * Extends the honesty model the dispatch event trail already uses: provider
 * acceptance is NOT delivery, and delivery is NOT someone seeing it. Each state
 * below is a different claim, and conflating them is how an operations report
 * ends up saying a dispatcher was alerted when nobody's phone made a sound.
 */
export enum PushDeliveryState {
    /** We decided to send. Nothing has left the building. */
    QUEUED = 'queued',

    /**
     * FCM accepted the message for this token.
     *
     * This means Google took it. It does NOT mean the device received it, the
     * phone was awake, the OS displayed it, or a human noticed.
     */
    PROVIDER_ACCEPTED = 'provider_accepted',

    /**
     * The service worker on the device ran its handler.
     *
     * The strongest evidence available without a human: the message reached the
     * browser and our code executed. Still not proof anyone heard it — the
     * phone may have been face-down in a pocket on silent.
     */
    SERVICE_WORKER_RECEIVED = 'service_worker_received',

    /** A human tapped the notification. The first state that implies a person. */
    NOTIFICATION_OPENED = 'notification_opened',

    /** They opened it AND the request loaded on their screen. */
    REQUEST_VIEWED = 'request_viewed',

    /** FCM rejected the send. */
    FAILED = 'failed',

    /** FCM says this token no longer exists. The row is deactivated. */
    TOKEN_INVALID = 'token_invalid',

    /** The browser has notification permission denied; nothing was attempted. */
    PERMISSION_DENIED = 'permission_denied',

    /** No token, push disabled, or something we genuinely cannot characterise. */
    UNKNOWN = 'unknown',
}

/** Why a push was sent — the first one, a reminder, or the last call. */
export enum PushReason {
    NEW_REQUEST = 'new_request',
    REMINDER = 'reminder',
    FINAL_REMINDER = 'final_reminder',
    TEST = 'test',
}

@Entity()
@Index(['jobId', 'staffUserId'])
@Index(['parkId', 'createdAt'])
export class StaffPushDelivery {
    @PrimaryGeneratedColumn('uuid')
    id!: string;

    @Index()
    @Column()
    staffUserId!: string;

    @Index()
    @Column({ type: 'varchar', nullable: true })
    parkId!: string | null;

    /** The ParkDispatchJob this was about. Null for a test push. */
    @Index()
    @Column({ type: 'varchar', nullable: true })
    jobId!: string | null;

    @Column({ type: 'varchar', nullable: true })
    rideId!: string | null;

    /** Which device row. Kept even after the token is revoked. */
    @Column({ type: 'varchar', nullable: true })
    staffDeviceTokenId!: string | null;

    /**
     * A short, non-reversible reference to the token.
     *
     * The last 12 characters, which is enough to match a delivery to a device
     * in a support conversation and useless to anyone who obtains the log. The
     * full token is a sending credential and does not belong in an audit row.
     */
    @Column({ type: 'varchar', length: 24, nullable: true })
    tokenRef!: string | null;

    @Column({ type: 'enum', enum: PushReason, default: PushReason.NEW_REQUEST })
    reason!: PushReason;

    @Column({ type: 'enum', enum: PushDeliveryState, default: PushDeliveryState.QUEUED })
    state!: PushDeliveryState;

    /** FCM's message id when it accepted, or its error code when it did not. */
    @Column({ type: 'varchar', length: 200, nullable: true })
    providerRef!: string | null;

    @Column({ type: 'jsonb', nullable: true })
    detail!: Record<string, unknown> | null;

    /** Set when the service worker acknowledged. */
    @Column({ type: 'timestamp', nullable: true })
    receivedAt!: Date | null;

    /** Set when a human tapped it. */
    @Column({ type: 'timestamp', nullable: true })
    openedAt!: Date | null;

    @CreateDateColumn()
    createdAt!: Date;
}
