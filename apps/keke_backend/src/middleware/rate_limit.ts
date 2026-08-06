import rateLimit, { ipKeyGenerator } from "express-rate-limit";

const adminWindowMs = parseInt(process.env.RATE_LIMIT_WINDOW || "900000");
/*
 * The admin dashboard legitimately polls: the Overview refreshes, the
 * Operations centre refreshes, and each page load fires a handful of requests.
 * 100 per fifteen minutes was sized for a human clicking around and is exceeded
 * by a screen nobody is touching — which is how a working dashboard came to
 * answer "rate limit exceeded" to every request for the rest of the window.
 *
 * Still bounded, and still low enough to stop enumeration: this is an
 * authenticated staff surface, not a public one.
 */
const adminMax = parseInt(process.env.ADMIN_RATE_LIMIT_MAX || "600");
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
    /*
     * Per staff member, not per IP.
     *
     * This used the default IP key, so every administrator in one office shared
     * a single budget and one person leaving a dashboard open exhausted it for
     * everybody. The same reasoning already applied to the onboarding and
     * upload limiters above — it was simply never applied here.
     *
     * Safe because adminLimiter is mounted AFTER resolveActor, so the staff
     * identity is resolved by the time this runs; the IP remains the fallback
     * for anything that reaches it unauthenticated.
     */
    keyGenerator: (req: any) =>
        req.actor?.staffUserId ? `staff:${req.actor.staffUserId}` : ipKeyGenerator(req.ip),
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
