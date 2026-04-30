import { Router, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { WalletService } from "../services/wallet_service";
import { PaystackService } from "../services/paystack_service";
import { AppDataSource } from "../config/data_source";
import { LedgerEntry } from "../models/LedgerEntry";
import { authMiddleware, AuthRequest } from "../middleware/auth_middleware";

const router = Router();

const topupLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many topup attempts. Please wait a minute before trying again.' },
    skip: () => process.env.NODE_ENV === 'development',
});

router.get("/balance/:userId", authMiddleware, async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.params.userId as string;
        if (req.user!.userId !== userId) {
            return res.status(403).json({ error: "Forbidden" });
        }
        const wallet = await WalletService.getOrCreateWallet(userId);
        const history = await AppDataSource.getRepository(LedgerEntry).find({
            where: { walletId: userId },
            order: { createdAt: "DESC" },
            take: 20
        });
        res.json({ balance: wallet, history });
    } catch (err: any) {
        res.status(500).json({ error: "Internal Server Error" });
    }
});

router.post("/topup/init", authMiddleware, topupLimiter, async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.user!.userId;
        const { email, amount } = req.body;
        if (!email || !amount || amount <= 0) {
            return res.status(400).json({ error: "Invalid email or amount" });
        }
        const result = await PaystackService.initializeTopup(userId, email, amount);
        res.json(result);
    } catch (err: any) {
        res.status(500).json({ error: "Internal Server Error" });
    }
});

router.post("/topup/verify", authMiddleware, topupLimiter, async (req: AuthRequest, res: Response) => {
    try {
        const { reference } = req.body;
        if (!reference) return res.status(400).json({ error: "Reference required" });
        const verified = await PaystackService.verifyTransaction(reference);
        res.json({ verified });
    } catch (err: any) {
        res.status(500).json({ error: "Internal Server Error" });
    }
});

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
