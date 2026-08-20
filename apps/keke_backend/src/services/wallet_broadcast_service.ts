/**
 * Tells a driver's phone that their money changed.
 *
 * ── Why this exists ──────────────────────────────────────────────────────
 * There was no wallet event at all. The driver app learned about a commission
 * charge or a top-up only by fetching the balance endpoint, which it does when
 * the wallet screen opens. So a driver watching that screen while a ride
 * completed, or while an admin funded them at the park, saw a stale number and
 * had no way to know it was stale.
 *
 * ── Never on the money path ──────────────────────────────────────────────
 * Every method is fire-and-forget and swallows its own errors. A socket
 * problem must never roll back a financial transaction — the money is already
 * committed and authoritative in Postgres by the time this runs.
 *
 * ── The event carries the numbers, not a nudge ───────────────────────────
 * Sending "something changed, go refetch" would be one more round trip during
 * which the screen is still wrong, and would fail entirely if the fetch
 * failed. The event carries the authoritative figures; the app can render
 * immediately. A missed event self-corrects on the next resume, because the
 * endpoint remains the source of truth.
 */
import { Wallet } from '../models/Wallet';

export type WalletEmitter = (driverId: string, event: string, payload: Record<string, unknown>) => void;

export interface WalletChangeReason {
    /** Stable code: ride_commission | topup | debt_recovery | payout | admin_adjustment | reversal */
    reason: string;
    rideId?: string | null;
    amount?: number | null;
    reference?: string | null;
}

export class WalletBroadcastService {
    private static emitter: WalletEmitter | null = null;

    static setEmitter(emitter: WalletEmitter | null): void {
        this.emitter = emitter;
    }

    /** Push the authoritative wallet state to the driver's device. */
    static walletChanged(driverId: string, wallet: Wallet, ctx: WalletChangeReason): void {
        try {
            if (!this.emitter) return;
            const available = Number(wallet.driverAvailableBalance);
            const debt = Number(wallet.driverCommissionDebt);
            this.emitter(driverId, 'wallet:updated', {
                availableBalance: available,
                outstandingDebt: debt,
                pendingBalance: Number(wallet.driverPendingBalance),
                // Computed server-side so the app never has to subtract debt
                // itself and get it wrong.
                withdrawable: Math.max(0, Math.round((available - debt) * 100) / 100),
                reason: ctx.reason,
                rideId: ctx.rideId ?? null,
                amount: ctx.amount ?? null,
                at: new Date().toISOString(),
            });
        } catch (err: any) {
            console.warn(`[WALLET_BROADCAST] failed for ${driverId}: ${err?.message}`);
        }
    }
}
