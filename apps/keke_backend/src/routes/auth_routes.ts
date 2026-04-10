import { Router, Request, Response } from "express";
import { AppDataSource } from "../config/data_source";
import { User, UserRole } from "../models/User";
import { AuthService } from "../services/auth_service";
import { DriverProfile } from "../models/DriverProfile";
import { authMiddleware, AuthRequest } from "../middleware/auth_middleware";

const router = Router();

/**
 * Handle Signup (Internal logic)
 */
async function handleSignup(req: Request, res: Response, role: UserRole) {
    try {
        const { phone, password, first_name, last_name } = req.body;

        if (!phone || !password || !first_name || !last_name) {
            return res.status(400).json({ error: "Missing required fields" });
        }

        const normalizedPhone = AuthService.normalizePhone(phone);
        const userRepo = AppDataSource.getRepository(User);

        // check uniqueness
        const existing = await userRepo.findOneBy({ phone: normalizedPhone });
        if (existing) {
            return res.status(409).json({ error: "Phone number already exists" });
        }

        const hashedPassword = await AuthService.hashPassword(password);
        const user = userRepo.create({
            phone: normalizedPhone,
            password: hashedPassword,
            firstName: first_name,
            lastName: last_name,
            role
        });

        await userRepo.save(user);

        // If driver, create initial profile (not approved)
        if (role === UserRole.DRIVER) {
            const profileRepo = AppDataSource.getRepository(DriverProfile);
            const profile = profileRepo.create({
                userId: user.id,
                firstName: first_name,
                lastName: last_name,
                vehiclePlate: "PENDING",    // Placeholder
                vehicleModel: "PENDING"     // Placeholder
            });
            await profileRepo.save(profile);
        }

        const token = AuthService.generateToken(user);
        res.json({ token });

    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
}

/**
 * Handle Login (Internal logic)
 */
async function handleLogin(req: Request, res: Response) {
    try {
        const { phone, password } = req.body;
        if (!phone || !password) {
            return res.status(400).json({ error: "Missing phone or password" });
        }

        const normalizedPhone = AuthService.normalizePhone(phone);
        const user = await AppDataSource.getRepository(User).findOneBy({ phone: normalizedPhone });

        if (!user || !(await AuthService.comparePassword(password, user.password))) {
            return res.status(401).json({ error: "Invalid credentials" });
        }

        const token = AuthService.generateToken(user);
        res.json({ token });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
}

// --- Passenger Routes ---
router.post("/signup", (req, res) => handleSignup(req, res, UserRole.PASSENGER));
router.post("/login", handleLogin);

// --- Identity Endpoint ---
router.get("/me", authMiddleware, async (req: AuthRequest, res: Response) => {
    try {
        if (!req.user) {
            return res.status(401).json({ error: "Unauthorized" });
        }

        const userRepo = AppDataSource.getRepository(User);
        const user = await userRepo.findOneBy({ id: req.user.userId });

        if (!user) {
            return res.status(404).json({ error: "User not found" });
        }

        // Return profile info expected by the app
        res.json({
            id: user.id,
            phone: user.phone,
            firstName: user.firstName,
            lastName: user.lastName,
            role: user.role
        });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

export default router;

// --- Driver Specific Exports ---
export const driverAuthRouter = Router();
driverAuthRouter.post("/signup", (req, res) => handleSignup(req, res, UserRole.DRIVER));
driverAuthRouter.post("/login", handleLogin);
