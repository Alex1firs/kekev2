import rateLimit from "express-rate-limit";

const adminWindowMs = parseInt(process.env.RATE_LIMIT_WINDOW || "900000");
const adminMax = parseInt(process.env.ADMIN_RATE_LIMIT_MAX || "100");
const onboardingMax = parseInt(process.env.ONBOARDING_RATE_LIMIT_MAX || "5");
const uploadMax = parseInt(process.env.UPLOAD_RATE_LIMIT_MAX || "30");

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
    message: {
        error: "Too Many Requests",
        message: "Too many uploads. Please wait a few minutes and try again.",
        status: 429
    }
});
