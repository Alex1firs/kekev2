/**
 * Pushes queue changes to connected Operations clients, and decides who to ring.
 *
 * ── Why a service and not inline emits ───────────────────────────────────
 * The queue row a dispatcher sees is assembled from the ride, the dispatch
 * rollup, presence and control. Rebuilding that in six places in the socket
 * handler would guarantee the six drift apart. This builds it once.
 *
 * ── Never on the critical path ───────────────────────────────────────────
 * Every method here is fire-and-forget and swallows its own errors. A ride
 * request must not be slower, or fail, because an Operations client is
 * watching it.
 */
import { OperationsQueueService, QueueRow } from './operations_queue_service';
import { OperationsNotificationService } from './operations_notification_service';
import { loadOperationsDispatchConfig } from '../config/operations_dispatch_config';

export type OpsEmitter = (event: string, payload: Record<string, unknown>) => void;

export class OperationsBroadcastService {
    private static emitter: OpsEmitter | null = null;

    static setEmitter(emitter: OpsEmitter | null): void {
        this.emitter = emitter;
    }

    /**
     * A ride changed. Rebuild its queue row, push it, and consider a
     * notification.
     *
     * `isNewRequest` distinguishes "a Keke was just requested" from "something
     * about an existing request moved", which is the difference between the
     * EVERY_REQUEST trigger firing and not.
     */
    static rideChanged(rideId: string, opts: { isNewRequest?: boolean } = {}): void {
        void this.rideChangedAsync(rideId, opts).catch((err: any) => {
            console.warn(`[OPS_BROADCAST] ${rideId} failed: ${err?.message}`);
        });
    }

    private static async rideChangedAsync(
        rideId: string,
        opts: { isNewRequest?: boolean },
    ): Promise<void> {
        const config = loadOperationsDispatchConfig();
        if (!config.enabled) return;

        // Reuses the queue builder rather than a second projection, so what is
        // pushed is byte-identical to what a refresh would fetch.
        const { rows } = await OperationsQueueService.liveQueue({ limit: 200 });
        const row = rows.find((r) => r.rideId === rideId);
        if (!row) return;

        try {
            this.emitter?.('ops:ride_update', row as unknown as Record<string, unknown>);
        } catch {
            /* an ops socket problem must never affect a ride */
        }

        await OperationsNotificationService.notify(row, {
            isNewRequest: opts.isNewRequest === true,
        });
    }

    /** Control changed hands. Pushed separately so clients update instantly. */
    static controlChanged(rideId: string, control: Record<string, unknown>): void {
        try {
            this.emitter?.('ops:control_update', { rideId, control });
        } catch {
            /* ignored by design */
        }
    }
}
