/**
 * Operations Dispatch tuning. Every timing knob lives here, following the same
 * convention as dispatch_config.ts and stale_ride_config.ts.
 */

function num(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw == null || raw.trim() === '') return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) {
        console.warn(`[ops-dispatch-config] ${name}="${raw}" is not valid — using ${fallback}`);
        return fallback;
    }
    return parsed;
}

function bool(name: string, fallback: boolean): boolean {
    const raw = process.env[name];
    if (raw == null || raw.trim() === '') return fallback;
    return raw.trim().toLowerCase() === 'true';
}

export interface OperationsDispatchConfig {
    /**
     * How long a takeover lease lives without renewal.
     *
     * Sized against the job, not against the network. A dispatcher takes over
     * because they are about to ring a driver and ask him to come online; that
     * call, plus the driver opening the app, is minutes rather than seconds.
     * Too short and control evaporates mid-call, which is exactly the failure
     * the lease exists to prevent. Too long and a dead client holds a
     * passenger's ride hostage.
     *
     * 3 minutes, renewed every 30s, tolerates six consecutive failed renewals
     * — comfortably more than a 4G handover or a backgrounded PWA.
     */
    leaseDurationMs: number;

    /** How often a live client should renew. Client-side cadence hint. */
    leaseRenewIntervalMs: number;

    /** How often the server sweeps for expired leases. */
    sweepIntervalMs: number;

    /** A ride waiting longer than this is NEEDS ATTENTION on time alone. */
    waitAttentionThresholdMs: number;

    /** Escalates to urgent. */
    waitUrgentThresholdMs: number;

    /** Master kill switch for the whole intervention capability. */
    enabled: boolean;

    /**
     * When false, Operations may observe the queue but cannot take over or
     * assign. Lets the console ship and be watched before anyone can touch a
     * live ride with it.
     */
    interventionEnabled: boolean;
}

export function loadOperationsDispatchConfig(): OperationsDispatchConfig {
    return {
        leaseDurationMs: num('OPS_LEASE_DURATION_MS', 180_000),
        leaseRenewIntervalMs: num('OPS_LEASE_RENEW_INTERVAL_MS', 30_000),
        sweepIntervalMs: num('OPS_SWEEP_INTERVAL_MS', 30_000),
        waitAttentionThresholdMs: num('OPS_WAIT_ATTENTION_MS', 45_000),
        waitUrgentThresholdMs: num('OPS_WAIT_URGENT_MS', 90_000),
        enabled: bool('OPS_DISPATCH_ENABLED', true),
        interventionEnabled: bool('OPS_INTERVENTION_ENABLED', true),
    };
}
