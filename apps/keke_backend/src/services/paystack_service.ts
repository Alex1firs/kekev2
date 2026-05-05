import axios from "axios";
import crypto from "crypto";
import dotenv from "dotenv";
import { AppDataSource } from "../config/data_source";
import { Transaction, TransactionStatus } from "../models/Transaction";
import { WalletService } from "./wallet_service";

dotenv.config();

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || "sk_test_placeholder";

export class PaystackService {
    /**
     * Initialize Paystack Top-up
     */
    static async initializeTopup(
        userId: string,
        email: string,
        amount: number,
        role: 'passenger' | 'driver' = 'passenger'
    ): Promise<{ authorization_url: string; reference: string }> {
        const reference = `KEKE-${Date.now()}-${Math.random().toString(36).substring(7)}`;
        const amountInKobo = Math.round(amount * 100);

        const response = await axios.post(
            "https://api.paystack.co/transaction/initialize",
            {
                email,
                amount: amountInKobo,
                reference,
                metadata: { userId, type: "wallet_topup", role }
            },
            {
                headers: {
                    Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
                    "Content-Type": "application/json"
                }
            }
        );

        if (response.data.status) {
            const tx = AppDataSource.getRepository(Transaction).create({
                userId,
                amount,
                reference,
                status: TransactionStatus.PENDING,
            }) as any;
            tx.role = role;
            await AppDataSource.getRepository(Transaction).save(tx);

            return {
                authorization_url: response.data.data.authorization_url,
                reference: response.data.data.reference
            };
        }

        throw new Error("Paystack initialization failed");
    }

    /**
     * Verify Webhook Signature
     */
    static verifyWebhookSignature(payload: string, signature: string): boolean {
        const hash = crypto
            .createHmac("sha512", PAYSTACK_SECRET_KEY)
            .update(payload)
            .digest("hex");
        
        return hash === signature;
    }

    /**
     * Finalize Top-up via Webhook (Idempotent)
     */
    static async handleWebhook(event: any): Promise<void> {
        if (event.event === "charge.success") {
            const data = event.data;
            const reference = data.reference;
            const amountInNaira = data.amount / 100;

            await WalletService.finalizeTopup(reference, amountInNaira);
        }
    }

    /**
     * Fallback Verification (Manually trigger update)
     */
    static async verifyTransaction(reference: string): Promise<boolean> {
        const response = await axios.get(`https://api.paystack.co/transaction/verify/${reference}`, {
            headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` }
        });

        if (response.data.status && response.data.data.status === "success") {
            const amountInNaira = response.data.data.amount / 100;
            await WalletService.finalizeTopup(reference, amountInNaira);
            return true;
        }

        return false;
    }
}
