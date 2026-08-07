/**
 * Make room broadcasts cross process boundaries.
 *
 * ── Why this exists ──────────────────────────────────────────────────────
 * During a blue-green deploy both colours run for a few minutes. A passenger
 * who books in that window is served by the new colour, while the drivers who
 * should receive the offer may still hold sockets on the old one. Without this,
 * `io.to('driver:X').emit(...)` reaches only the sockets in the emitting
 * process, and those drivers would never see the request.
 *
 * ── What it does NOT change ──────────────────────────────────────────────
 * Nothing in socket_handler.ts. Every `io.to(room).emit(...)` call site is
 * untouched; the adapter is installed on the Server instance and changes only
 * how a broadcast is routed. That was possible because every emit in this
 * codebase targets a ROOM. Had any of them targeted a socket id, this would
 * have been a rewrite instead of a plug-in.
 *
 * ── Fails soft, and can be switched off ──────────────────────────────────
 * If Redis is unreachable or the adapter cannot be created, the server logs it
 * and carries on with the default in-memory adapter — degraded to
 * single-process broadcasting, which is exactly how it behaved before. A
 * broadcasting optimisation must never stop the process that carries ride
 * requests from starting.
 *
 * `SOCKET_REDIS_ADAPTER=false` disables it outright. That plus a restart is the
 * whole remediation if it ever misbehaves in production.
 *
 * ── Separate connections, deliberately ───────────────────────────────────
 * Redis pub/sub puts a connection into subscriber mode, where it can no longer
 * run ordinary commands. Sharing the application's client would break every
 * GEORADIUS and presence read in the platform, so this duplicates it twice.
 */

import type { Server } from 'socket.io';
import { redis } from '../config/redis';

export interface AdapterResult {
    enabled: boolean;
    reason?: string;
}

function log(level: 'info' | 'warn' | 'error', message: string, extra: Record<string, unknown> = {}) {
    console.log(JSON.stringify({ level, scope: 'socket_adapter', message, ...extra }));
}

export async function installRedisAdapter(io: Server): Promise<AdapterResult> {
    if (String(process.env.SOCKET_REDIS_ADAPTER ?? 'true').toLowerCase() === 'false') {
        log('info', 'Redis adapter disabled by SOCKET_REDIS_ADAPTER=false; broadcasts stay in-process.');
        return { enabled: false, reason: 'disabled_by_env' };
    }

    try {
        const { createAdapter } = await import('@socket.io/redis-adapter');

        /*
         * duplicate() rather than reuse. A subscriber connection cannot issue
         * normal commands, and the shared client is doing GEORADIUS for driver
         * search and presence lookups on every dispatch.
         */
        const pubClient = redis.duplicate();
        const subClient = redis.duplicate();

        // ioredis reconnects on its own; these are for visibility, not recovery.
        // Swallowed rather than thrown: an unhandled 'error' event on an ioredis
        // client takes the process down, and losing the API because pub/sub
        // hiccupped would be far worse than a missed broadcast.
        pubClient.on('error', (e: Error) => log('warn', 'adapter pub client error', { error: e.message }));
        subClient.on('error', (e: Error) => log('warn', 'adapter sub client error', { error: e.message }));

        io.adapter(createAdapter(pubClient, subClient));
        log('info', 'Redis adapter installed; room broadcasts now cross processes.');
        return { enabled: true };
    } catch (err: any) {
        log('error', 'Could not install the Redis adapter; continuing in-process.', {
            error: String(err?.message ?? err),
        });
        return { enabled: false, reason: String(err?.message ?? err) };
    }
}
