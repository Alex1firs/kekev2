import rateLimit, { ipKeyGenerator } from "express-rate-limit";

const adminWindowMs = parseInt(process.env.RATE_LIMIT_WINDOW || "900000");
const adminMax = parseInt(process.env.ADMIN_RATE_LIMIT_MAX || "100");
const onboardingMax = parseInt(process.env.ONBOARDING_RATE_LIMIT_MAX || "20");
const uploadMax = parseInt(process.env.UPLOAD_RATE_LIMIT_MAX || "30");

/**
 * Key per authenticated driver (these routes run authMiddleware first), falling
 * back to a per-IP key for the rare unauthenticated case. Keying by userId is
 * both correct (onboarding/upload are one-time per-driver actions) and immune to
 * the shared-IP problems of mobile carrier NAT and reverse proxies — otherwise
 * many drivers behind one IP share a single tiny budget.
 */
const perUserOrIp = (req: any): string =>
    req.user?.userId ? `user:${req.user.userId}` : ipKeyGenerator(req.ip);

export const adminLimiter = rateLimit({
    windowMs: adminWindowMs,
    max: adminMax,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        error: "Too Many Requests",
        message: "Admin rate limit exceeded. Please try again later.",
        status: 429
    },
    skip: (req) => process.env.NODE_ENV === "development"
});

export const onboardingLimiter = rateLimit({
    windowMs: adminWindowMs,
    max: onboardingMax,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: perUserOrIp,
    message: {
        error: "Too Many Requests",
        message: "Onboarding rate limit exceeded. Please try again later.",
        status: 429
    }
});

export const uploadLimiter = rateLimit({
    windowMs: adminWindowMs,
    max: uploadMax,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: perUserOrIp,
    message: {
        error: "Too Many Requests",
        message: "Too many uploads. Please wait a few minutes and try again.",
        status: 429
    }
});
