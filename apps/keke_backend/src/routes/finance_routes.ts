import { Router, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { Not, In } from "typeorm";
import { WalletService } from "../services/wallet_service";
import { PaystackService } from "../services/paystack_service";
import { AppDataSource } from "../config/data_source";
import { LedgerEntry, BalanceType, TransactionType } from "../models/LedgerEntry";
import { Ride, RideStatus } from "../models/Ride";
import { authMiddleware, AuthRequest } from "../middleware/auth_middleware";
import { errBody, ErrorCode } from "../utils/errors";

const router = Router();

const topupLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: errBody(ErrorCode.RATE_LIMITED, "Too many attempts. Please wait a minute before trying again."),
    skip: () => process.env.NODE_ENV === 'development',
});

router.get("/balance/:userId", authMiddleware, async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.params.userId as string;
        if (req.user!.userId !== userId) {
            return res.status(403).json(errBody(ErrorCode.FORBIDDEN, "Access denied."));
        }
        const wallet = await WalletService.getOrCreateWallet(userId);
        // Exclude internal bookkeeping entries (debt ledger, platform revenue) — they are
        // not meaningful to the end user and would show as confusing duplicate lines.
        // We filter in memory rather than in the DB query to avoid Postgres enum cast
        // errors if the production database is missing newer enum values.
        let history = await AppDataSource.getRepository(LedgerEntry).find({
            where: {
                walletId: userId,
            },
            order: { createdAt: "DESC" },
            take: 40 // Fetch a bit more to ensure we have 20 after filtering
        });

        history = history.filter(h => 
            h.balanceType !== BalanceType.DRIVER_COMMISSION_DEBT && 
            h.balanceType !== BalanceType.PLATFORM_REVENUE
        ).slice(0, 20);

        const totalTrips = await AppDataSource.getRepository(Ride).count({
            where: { driverId: userId, status: RideStatus.COMPLETED }
        });

        const walletRidesSumResult = await AppDataSource.getRepository(Ride)
            .createQueryBuilder("ride")
            .select("SUM(ride.fare)", "sum")
            .where("ride.driverId = :driverId AND ride.status = :status AND ride.paymentMode = :paymentMode", {
                driverId: userId,
                status: RideStatus.COMPLETED,
                paymentMode: "wallet"
            })
            .getRawOne();
        const walletCommissionSum = Number(walletRidesSumResult?.sum || 0) * 0.10;

        const ledgerChargesResult = await AppDataSource.getRepository(LedgerEntry)
            .createQueryBuilder("ledger")
            .select("SUM(ABS(ledger.amount))", "sum")
            .where("ledger.walletId = :walletId AND ledger.balanceType = :balanceType AND ledger.transactionType IN (:...types)", {
                walletId: userId,
                balanceType: BalanceType.DRIVER_AVAILABLE,
                types: [TransactionType.COMMISSION_CHARGE, TransactionType.DEBT_RECOVERY]
            })
            .getRawOne();
        const ledgerCommissionSum = Number(ledgerChargesResult?.sum || 0);
        const totalCommissionPaid = Math.round((walletCommissionSum + ledgerCommissionSum) * 100) / 100;

        res.json({ balance: wallet, history, totalTrips, totalCommissionPaid });
    } catch (err: any) {
        console.error('[FINANCE] Balance fetch error:', err?.message);
        res.status(500).json(errBody(ErrorCode.INTERNAL_ERROR, "We couldn't load your balance right now. Please try again."));
    }
});

router.post("/topup/init", authMiddleware, topupLimiter, async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.user!.userId;
        const { email, amount } = req.body ?? {};
        if (!email || !amount || amount <= 0) {
            return res.status(400).json(errBody(ErrorCode.VALIDATION_ERROR, "A valid email and amount are required."));
        }
        const result = await PaystackService.initializeTopup(userId, email, amount);
        res.json(result);
    } catch (err: any) {
        console.error('[FINANCE] Topup init error:', err?.message);
        res.status(500).json(errBody(ErrorCode.PAYMENT_FAILED, "We couldn't initialize the top-up right now. Please try again."));
    }
});

router.post("/topup/driver/init", authMiddleware, topupLimiter, async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.user!.userId;
        const { email, amount } = req.body ?? {};
        if (!email || !amount || amount <= 0) {
            return res.status(400).json(errBody(ErrorCode.VALIDATION_ERROR, "A valid email and amount are required."));
        }
        const result = await PaystackService.initializeTopup(userId, email, amount, 'driver');
        res.json(result);
    } catch (err: any) {
        console.error('[FINANCE] Driver topup init error:', err?.message);
        res.status(500).json(errBody(ErrorCode.PAYMENT_FAILED, "We couldn't initialize the top-up right now. Please try again."));
    }
});

router.post("/payout/init", authMiddleware, async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.user!.userId;
        const { amount, bankCode, accountNumber } = req.body ?? {};
        if (!amount || amount <= 0 || !bankCode || !accountNumber) {
            return res.status(400).json(errBody(ErrorCode.VALIDATION_ERROR, "Amount, bank code, and account number are required."));
        }
        const payout = await WalletService.initiatePayout(userId, Number(amount), bankCode.toString(), accountNumber.toString());
        res.json({ payout });
    } catch (err: any) {
        console.error('[FINANCE] Payout error:', err?.message);
        // Detect insufficient balance without leaking the exact amounts
        const isInsufficient = err.message?.toLowerCase().includes('insufficient');
        if (isInsufficient) {
            return res.status(400).json(errBody(ErrorCode.INSUFFICIENT_WALLET_BALANCE, "Your available balance is not enough for this payout."));
        }
        res.status(500).json(errBody(ErrorCode.PAYMENT_FAILED, "We couldn't process your payout right now. Please try again."));
    }
});

router.post("/debt/repay", authMiddleware, async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.user!.userId;
        const { applied, remainingDebt } = await WalletService.repayDebtFromBalance(userId);
        res.json({ applied, remainingDebt });
    } catch (err: any) {
        console.error('[FINANCE] Debt repay error:', err?.message);
        res.status(500).json(errBody(ErrorCode.INTERNAL_ERROR, "We couldn't process your repayment right now. Please try again."));
    }
});

router.post("/topup/verify", authMiddleware, topupLimiter, async (req: AuthRequest, res: Response) => {
    try {
        const { reference } = req.body ?? {};
        if (!reference) return res.status(400).json(errBody(ErrorCode.MISSING_FIELDS, "Payment reference is required."));
        const verified = await PaystackService.verifyTransaction(reference);
        res.json({ verified });
    } catch (err: any) {
        console.error('[FINANCE] Topup verify error:', err?.message);
        res.status(500).json(errBody(ErrorCode.PAYMENT_FAILED, "We couldn't verify your payment right now. Please try again."));
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
        console.error("Webhook error:", err?.message);
        res.status(500).send("Internal server error");
    }
});

export default router;
