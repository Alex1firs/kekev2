import { Router, Response } from "express";
import { AppDataSource } from "../config/data_source";
import { SavedLocation } from "../models/SavedLocation";
import { authMiddleware, AuthRequest } from "../middleware/auth_middleware";
import { errBody, ErrorCode } from "../utils/errors";

const router = Router();

/**
 * GET /api/v1/passenger/saved-locations
 * List all saved locations for the authenticated user.
 */
router.get("/saved-locations", authMiddleware, async (req: AuthRequest, res: Response) => {
    try {
        const repo = AppDataSource.getRepository(SavedLocation);
        const locations = await repo.find({
            where: { userId: req.user!.userId },
            order: { name: "ASC" }
        });
        return res.json(locations);
    } catch (err: any) {
        console.error('[PASSENGER] Fetch saved locations error:', err?.message);
        return res.status(500).json(errBody(ErrorCode.INTERNAL_ERROR, "Failed to load saved locations."));
    }
});

/**
 * POST /api/v1/passenger/saved-locations
 * Add a new saved location.
 */
router.post("/saved-locations", authMiddleware, async (req: AuthRequest, res: Response) => {
    try {
        const { name, address, lat, lng } = req.body;
        if (!name || !address || lat === undefined || lng === undefined) {
            return res.status(400).json(errBody(ErrorCode.MISSING_FIELDS, "Name, address, lat, and lng are required."));
        }

        const repo = AppDataSource.getRepository(SavedLocation);
        const count = await repo.count({ where: { userId: req.user!.userId } });

        if (count >= 5) {
            return res.status(400).json(errBody(ErrorCode.VALIDATION_ERROR, "You can only save up to 5 locations."));
        }

        const location = repo.create({
            userId: req.user!.userId,
            name,
            address,
            lat,
            lng
        });

        await repo.save(location);
        return res.status(201).json(location);
    } catch (err: any) {
        console.error('[PASSENGER] Create saved location error:', err?.message);
        return res.status(500).json(errBody(ErrorCode.INTERNAL_ERROR, "Failed to save location."));
    }
});

/**
 * DELETE /api/v1/passenger/saved-locations/:id
 * Delete a saved location.
 */
router.delete("/saved-locations/:id", authMiddleware, async (req: AuthRequest, res: Response) => {
    try {
        const { id } = req.params;
        const repo = AppDataSource.getRepository(SavedLocation);
        const location = await repo.findOne({ where: { id: id as string, userId: req.user!.userId } });

        if (!location) {
            return res.status(404).json(errBody(ErrorCode.NOT_FOUND, "Location not found."));
        }

        await repo.remove(location);
        return res.json({ message: "Location deleted successfully." });
    } catch (err: any) {
        console.error('[PASSENGER] Delete saved location error:', err?.message);
        return res.status(500).json(errBody(ErrorCode.INTERNAL_ERROR, "Failed to delete location."));
    }
});

export default router;
