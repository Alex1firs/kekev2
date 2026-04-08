import { Router, Request, Response } from "express";
import { WalletService } from "../services/wallet_service";
import { PaystackService } from "../services/paystack_service";
import { AppDataSource } from "../config/data_source";
import { LedgerEntry } from "../models/LedgerEntry";

const router = Router();

/**
 * Get Wallet Balance & History
 */
router.get("/balance/:userId", async (req: Request, res: Response) => {
    try {
        const userId = req.params.userId as string;
        const wallet = await WalletService.getOrCreateWallet(userId);
        const history = await AppDataSource.getRepository(LedgerEntry).find({
            where: { walletId: userId },
            order: { createdAt: "DESC" },
            take: 20
        });

        res.json({
            balance: wallet,
            history
        });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * Initialize Top-up
 */
router.post("/topup/init", async (req: Request, res: Response) => {
    try {
        const { userId, email, amount } = req.body;
        const result = await PaystackService.initializeTopup(userId, email, amount);
        res.json(result);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * Manual Verify
 */
router.post("/topup/verify", async (req: Request, res: Response) => {
    try {
        const { reference } = req.body;
        const verified = await PaystackService.verifyTransaction(reference);
        res.json({ verified });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * Paystack Webhook
 */
router.post("/webhook", async (req: Request, res: Response) => {
    const signature = req.headers["x-paystack-signature"] as string;
    const body = JSON.stringify(req.body);

    if (!PaystackService.verifyWebhookSignature(body, signature)) {
        return res.status(400).send("Invalid signature");
    }

    try {
        await PaystackService.handleWebhook(req.body);
        res.sendStatus(200);
    } catch (err: any) {
        console.error("Webhook error:", err);
        res.status(500).send("Internal server error");
    }
});

export default router;
