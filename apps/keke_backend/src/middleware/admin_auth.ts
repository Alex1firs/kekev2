import { Request, Response, NextFunction } from "express";
import dotenv from "dotenv";

dotenv.config();

const ADMIN_API_KEY = process.env.ADMIN_API_KEY;

/**
 * The shared-key era is being retired (see docs/admin_auth_migration.md).
 *
 * While it is still enabled a key MUST be configured — starting without one
 * would leave the admin surface reachable by whatever fell through. Once an
 * operator sets LEGACY_ADMIN_KEY_ENABLED=false, staff sessions are the only way
 * in and no key is needed, so the guard steps aside rather than blocking a
 * fully-migrated deployment from booting.
 */
const LEGACY_ENABLED = process.env.LEGACY_ADMIN_KEY_ENABLED !== 'false';

if (LEGACY_ENABLED && !ADMIN_API_KEY) {
    const msg = "FATAL: ADMIN_API_KEY is not defined and LEGACY_ADMIN_KEY_ENABLED is not 'false'. Server cannot start.";
    console.error(msg);
    throw new Error(msg);
}

/**
 * Front gate for the admin surface.
 *
 * Accepts a request that presents EITHER:
 *   - an `Authorization: Bearer` token, whose validity is then established by
 *     resolveActor + requireStaffAuth (this middleware deliberately does not
 *     verify it — one verifier, in one place); or
 *   - an `x-admin-key` matching a configured legacy key, while legacy access
 *     is still enabled.
 *
 * Anything else is refused here, so an unauthenticated request never reaches
 * identity resolution at all.
 */
export const adminAuth = (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        // A staff session is being presented. requireStaffAuth decides.
        return next();
    }

    if (!LEGACY_ENABLED) {
        return res.status(401).json({
            error: "Unauthorized",
            message: "Shared admin keys are disabled. Sign in with a staff account."
        });
    }

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
