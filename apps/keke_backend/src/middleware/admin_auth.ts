import { Request, Response, NextFunction } from "express";
import dotenv from "dotenv";

dotenv.config();

const ADMIN_API_KEY = process.env.ADMIN_API_KEY;

if (!ADMIN_API_KEY) {
    const msg = "FATAL: ADMIN_API_KEY is not defined in environment variables. Server cannot start.";
    console.error(msg);
    throw new Error(msg);
}

/**
 * Modular Admin Authentication Middleware
 * Validates X-Admin-Key header for bootstrap security.
 */
export const adminAuth = (req: Request, res: Response, next: NextFunction) => {
    const apiKey = req.headers["x-admin-key"] as string | undefined;

    // The primary key always works. Optional scoped keys (operations / support /
    // readonly) authenticate too and are resolved to a role by
    // attachAdminIdentity; see middleware/admin_permissions.ts.
    const scopedKeys = [
        process.env.ADMIN_OPERATIONS_API_KEY,
        process.env.ADMIN_SUPPORT_API_KEY,
        process.env.ADMIN_READONLY_API_KEY,
    ].filter((k): k is string => !!k && k.length > 0);

    const accepted = !!apiKey && (apiKey === ADMIN_API_KEY || scopedKeys.includes(apiKey));

    if (!accepted) {
        return res.status(401).json({
            error: "Unauthorized",
            message: "Missing or invalid Admin API Key"
        });
    }

    // Success: proceed to admin endpoint
    next();
};
