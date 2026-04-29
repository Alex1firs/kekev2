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
    const apiKey = req.headers["x-admin-key"];

    if (!apiKey || apiKey !== ADMIN_API_KEY) {
        return res.status(401).json({
            error: "Unauthorized",
            message: "Missing or invalid Admin API Key"
        });
    }

    // Success: proceed to admin endpoint
    next();
};
