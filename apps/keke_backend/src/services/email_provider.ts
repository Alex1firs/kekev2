/**
 * The seam between KekeRide and whoever carries its email.
 *
 * ── Why an abstraction rather than calling Resend directly ───────────────
 * The existing transactional path calls `resend.emails.send` inline, which is
 * fine for two OTP messages. A campaign system is different: it retries, it
 * resumes, it reconciles webhooks, and it will one day need a second provider —
 * either because the first has an outage during a send, or because marketing
 * volume gets moved off the domain that carries password resets. Every one of
 * those is painful to retrofit and cheap to allow for now.
 *
 * The interface is deliberately small. Anything a provider cannot do uniformly
 * — scheduling, suppression lists, template storage — stays on our side, where
 * we can reason about it.
 */

import { Resend } from 'resend';
import { loadCommunicationsConfig } from '../config/communications_config';

export interface OutboundEmail {
    to: string;
    subject: string;
    html: string;
    text: string;
    fromName: string;
    fromAddress: string;
    replyTo?: string | null;
    /**
     * Sent to the provider so a retry after an ambiguous timeout cannot
     * produce a second delivery.
     */
    idempotencyKey?: string;
    /**
     * RFC 8058 one-click unsubscribe. Gmail and Yahoo require it on bulk mail;
     * without it they are markedly more likely to treat the message as spam,
     * and a passenger's only way to stop it becomes the complaint button.
     */
    listUnsubscribeUrl?: string | null;
    headers?: Record<string, string>;
}

export interface SendResult {
    ok: boolean;
    /** The provider's id, for tying webhooks back to the recipient row. */
    messageId?: string | null;
    error?: string;
    /**
     * Whether trying again could plausibly work. A malformed address is
     * permanent; a 429 or a 503 is not. Retrying a permanent failure just
     * burns quota and delays the campaign.
     */
    retryable?: boolean;
}

export interface EmailProvider {
    readonly name: string;
    send(email: OutboundEmail): Promise<SendResult>;
    /** Whether this provider is configured well enough to be used at all. */
    isConfigured(): boolean;
    /**
     * Confirm a webhook really came from the provider. A campaign's suppression
     * list is driven by these events, so an unverified endpoint is a way for a
     * stranger to suppress every address we have.
     */
    verifyWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>): boolean;
}

/** Resend. The provider already carrying KekeRide's transactional mail. */
export class ResendProvider implements EmailProvider {
    readonly name = 'resend';
    private client: Resend | null;

    constructor(apiKey: string | undefined = process.env.RESEND_API_KEY) {
        this.client = apiKey ? new Resend(apiKey) : null;
    }

    isConfigured(): boolean {
        return this.client != null;
    }

    async send(email: OutboundEmail): Promise<SendResult> {
        if (!this.client) {
            return { ok: false, error: 'RESEND_API_KEY is not configured', retryable: false };
        }

        const headers: Record<string, string> = { ...(email.headers ?? {}) };
        if (email.listUnsubscribeUrl) {
            headers['List-Unsubscribe'] = `<${email.listUnsubscribeUrl}>`;
            headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
        }
        if (email.idempotencyKey) {
            headers['Idempotency-Key'] = email.idempotencyKey;
        }

        try {
            const res = await this.client.emails.send({
                from: `${email.fromName} <${email.fromAddress}>`,
                to: email.to,
                subject: email.subject,
                html: email.html,
                text: email.text,
                replyTo: email.replyTo || undefined,
                headers,
            } as any);

            if ((res as any)?.error) {
                const err = (res as any).error;
                return {
                    ok: false,
                    error: String(err.message ?? err),
                    retryable: this.isRetryable(String(err.name ?? ''), String(err.message ?? '')),
                };
            }
            return { ok: true, messageId: (res as any)?.data?.id ?? null };
        } catch (err: any) {
            /*
             * A thrown error is usually a network fault or a timeout, and a
             * timeout is the dangerous case: the message may well have been
             * accepted. Treated as retryable, which is safe only because the
             * idempotency key stops the retry becoming a second email.
             */
            return {
                ok: false,
                error: String(err?.message ?? err),
                retryable: true,
            };
        }
    }

    private isRetryable(name: string, message: string): boolean {
        const permanent = /invalid|validation|not_found|unprocessable|forbidden|unauthorized/i;
        if (permanent.test(name) || permanent.test(message)) return false;
        return /rate|limit|timeout|temporar|unavailable|internal|502|503|504|429/i.test(`${name} ${message}`);
    }

    /**
     * Svix-signed webhooks, which is what Resend uses.
     *
     * Verified with a timing-safe comparison over the documented
     * `id.timestamp.body` payload, and only against the version-tagged
     * signatures. An unsigned or stale request is rejected rather than trusted,
     * because these events drive suppression.
     */
    verifyWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>): boolean {
        const secret = process.env.RESEND_WEBHOOK_SECRET;
        if (!secret) return false;

        const get = (k: string) => {
            const v = headers[k] ?? headers[k.toLowerCase()];
            return Array.isArray(v) ? v[0] : v;
        };
        const id = get('svix-id');
        const timestamp = get('svix-timestamp');
        const signature = get('svix-signature');
        if (!id || !timestamp || !signature) return false;

        // Reject anything older than five minutes: a captured event must not be
        // replayable indefinitely.
        const age = Math.abs(Date.now() / 1000 - Number(timestamp));
        if (!Number.isFinite(age) || age > 300) return false;

        const crypto = require('crypto') as typeof import('crypto');
        const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
        const expected = crypto
            .createHmac('sha256', key)
            .update(`${id}.${timestamp}.${rawBody}`)
            .digest('base64');

        for (const part of String(signature).split(' ')) {
            const [version, value] = part.split(',');
            if (version !== 'v1' || !value) continue;
            const a = Buffer.from(value);
            const b = Buffer.from(expected);
            if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
        }
        return false;
    }
}

/**
 * Records what it was asked to send and sends nothing.
 *
 * Used by every test and by any environment without a key, so a misconfigured
 * staging cannot quietly deliver a campaign to real addresses.
 */
export class NullProvider implements EmailProvider {
    readonly name = 'null';
    readonly sent: OutboundEmail[] = [];

    isConfigured(): boolean { return true; }

    async send(email: OutboundEmail): Promise<SendResult> {
        this.sent.push(email);
        return { ok: true, messageId: `null-${this.sent.length}` };
    }

    verifyWebhook(): boolean { return true; }
}

let provider: EmailProvider | null = null;

/**
 * The provider in force.
 *
 * Falls back to NullProvider when nothing is configured — a missing key must
 * mean "sends nothing", never "sends via some default".
 */
export function emailProvider(): EmailProvider {
    if (provider) return provider;
    const resend = new ResendProvider();
    provider = resend.isConfigured() ? resend : new NullProvider();
    return provider;
}

/** Swap the provider. Tests only. */
export function setEmailProvider(next: EmailProvider | null): void {
    provider = next;
}

/** Sender identity, resolved once so every message agrees. */
export function senderIdentity() {
    const cfg = loadCommunicationsConfig();
    return {
        fromName: cfg.fromName,
        fromAddress: cfg.fromAddress,
        replyTo: cfg.replyToAddress,
    };
}
