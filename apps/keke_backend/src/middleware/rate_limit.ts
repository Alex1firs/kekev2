import rateLimit from "express-rate-limit";

/**
 * Admin Rate Limiter
 * 100 requests per 15 minutes
 */
export const adminLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        error: "Too Many Requests",
        message: "Admin rate limit exceeded. Please try again later.",
        status: 429
    },
    skip: (req) => process.env.NODE_ENV === "development" // Optional: skip in dev
});

/**
 * Onboarding Rate Limiter
 * 5 requests per 15 minutes (Protects against bot signup)
 */
export const onboardingLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        error: "Too Many Requests",
        message: "Onboarding rate limit exceeded. Please try again later.",
        status: 429
    }
});
