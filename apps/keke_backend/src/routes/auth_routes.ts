import { Router, Request, Response } from "express";
import { AppDataSource } from "../config/data_source";
import { User, UserRole } from "../models/User";
import { AuthService } from "../services/auth_service";
import { EmailService } from "../services/email_service";
import { DriverProfile } from "../models/DriverProfile";
import { authMiddleware, AuthRequest } from "../middleware/auth_middleware";
import { redis } from "../config/redis";

const router = Router();

function generateOtp(): string {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

async function storeOtp(key: string, otp: string): Promise<void> {
    await redis.set(key, otp, 'EX', 600);
}

async function verifyAndConsumeOtp(key: string, otp: string): Promise<boolean> {
    const stored = await redis.get(key);
    if (!stored || stored !== otp.toString()) return false;
    await redis.del(key);
    return true;
}

async function handleSignup(req: Request, res: Response, role: UserRole) {
    try {
        const { email, password, first_name, last_name, phone } = req.body;

        if (!email || !password || !first_name || !last_name) {
            return res.status(400).json({ error: "Missing required fields" });
        }
        if (!AuthService.validateEmail(email)) {
            return res.status(400).json({ error: "Invalid email address" });
        }
        if (password.length < 8) {
            return res.status(400).json({ error: "Password must be at least 8 characters" });
        }

        const normalizedEmail = AuthService.normalizeEmail(email);
        const userRepo = AppDataSource.getRepository(User);

        const existing = await userRepo.findOneBy({ email: normalizedEmail });
        if (existing) {
            return res.status(409).json({ error: "Email address already registered" });
        }

        const hashedPassword = await AuthService.hashPassword(password);
        const user = userRepo.create({
            email: normalizedEmail,
            phone: phone ? AuthService.normalizePhone(phone) : undefined,
            password: hashedPassword,
            firstName: first_name,
            lastName: last_name,
            role,
            emailVerified: false,
        });

        await userRepo.save(user);

        if (role === UserRole.DRIVER) {
            const profileRepo = AppDataSource.getRepository(DriverProfile);
            const profile = profileRepo.create({
                userId: user.id,
                firstName: first_name,
                lastName: last_name,
                vehiclePlate: "PENDING",
                vehicleModel: "PENDING"
            });
            await profileRepo.save(profile);
        }

        const otp = generateOtp();
        await storeOtp(`email_verify:${normalizedEmail}`, otp);
        await EmailService.sendVerificationOtp(normalizedEmail, otp);

        const response: any = { message: "Account created. Check your email for a verification code." };
        if (process.env.NODE_ENV !== 'production') {
            response.otp = otp;
        }
        return res.status(201).json(response);

    } catch (err: any) {
        return res.status(500).json({ error: err.message });
    }
}

async function handleLogin(req: Request, res: Response) {
    try {
        const { email, password } = req.body;
        if (!email || !password) {
            return res.status(400).json({ error: "Missing email or password" });
        }

        const normalizedEmail = AuthService.normalizeEmail(email);
        const user = await AppDataSource.getRepository(User).findOneBy({ email: normalizedEmail });

        if (!user || !(await AuthService.comparePassword(password, user.password))) {
            return res.status(401).json({ error: "Invalid credentials" });
        }

        if (!user.emailVerified) {
            const otp = generateOtp();
            await storeOtp(`email_verify:${normalizedEmail}`, otp);
            await EmailService.sendVerificationOtp(normalizedEmail, otp);

            const response: any = {
                error: "EMAIL_NOT_VERIFIED",
                message: "Your email is not verified. A new code has been sent.",
                email: normalizedEmail,
            };
            if (process.env.NODE_ENV !== 'production') {
                response.otp = otp;
            }
            return res.status(403).json(response);
        }

        const token = AuthService.generateToken(user);
        return res.json({ token });
    } catch (err: any) {
        return res.status(500).json({ error: err.message });
    }
}

// --- Passenger Routes ---
router.post("/signup", (req, res) => handleSignup(req, res, UserRole.PASSENGER));
router.post("/login", handleLogin);

// --- Identity Endpoint ---
router.get("/me", authMiddleware, async (req: AuthRequest, res: Response) => {
    try {
        if (!req.user) return res.status(401).json({ error: "Unauthorized" });

        const user = await AppDataSource.getRepository(User).findOneBy({ id: req.user.userId });
        if (!user) return res.status(404).json({ error: "User not found" });

        return res.json({
            id: user.id,
            email: user.email,
            phone: user.phone,
            firstName: user.firstName,
            lastName: user.lastName,
            role: user.role,
            emailVerified: user.emailVerified,
        });
    } catch (err: any) {
        return res.status(500).json({ error: err.message });
    }
});

// --- Email Verification ---
router.post("/email-verification/request", async (req: Request, res: Response) => {
    try {
        const { email } = req.body;
        if (!email) return res.status(400).json({ error: "Email is required" });

        const normalizedEmail = AuthService.normalizeEmail(email);
        const user = await AppDataSource.getRepository(User).findOneBy({ email: normalizedEmail });

        // Don't leak whether the email exists
        if (!user || user.emailVerified) {
            return res.json({ message: "If that address is registered and unverified, a code has been sent." });
        }

        // Resend cooldown: 60 seconds
        const cooldownKey = `email_verify_cooldown:${normalizedEmail}`;
        const onCooldown = await redis.get(cooldownKey);
        if (onCooldown) {
            return res.status(429).json({ error: "Please wait before requesting another code." });
        }

        const otp = generateOtp();
        await storeOtp(`email_verify:${normalizedEmail}`, otp);
        await redis.set(cooldownKey, '1', 'EX', 60);
        await EmailService.sendVerificationOtp(normalizedEmail, otp);

        const response: any = { message: "Verification code sent." };
        if (process.env.NODE_ENV !== 'production') {
            response.otp = otp;
        }
        return res.json(response);
    } catch (err: any) {
        return res.status(500).json({ error: "Internal Server Error" });
    }
});

router.post("/email-verification/confirm", async (req: Request, res: Response) => {
    try {
        const { email, otp } = req.body;
        if (!email || !otp) return res.status(400).json({ error: "email and otp are required" });

        const normalizedEmail = AuthService.normalizeEmail(email);

        const attemptsKey = `email_verify_attempts:${normalizedEmail}`;
        const attempts = parseInt(await redis.get(attemptsKey) || '0');
        if (attempts >= 5) {
            return res.status(429).json({ error: "Too many failed attempts. Request a new code." });
        }

        const valid = await verifyAndConsumeOtp(`email_verify:${normalizedEmail}`, otp.toString());
        if (!valid) {
            await redis.set(attemptsKey, (attempts + 1).toString(), 'EX', 600);
            return res.status(400).json({ error: "Invalid or expired code" });
        }

        await redis.del(attemptsKey);
        await redis.del(`email_verify_cooldown:${normalizedEmail}`);

        const userRepo = AppDataSource.getRepository(User);
        const user = await userRepo.findOneBy({ email: normalizedEmail });
        if (!user) return res.status(404).json({ error: "User not found" });

        user.emailVerified = true;
        user.emailVerifiedAt = new Date();
        await userRepo.save(user);

        const token = AuthService.generateToken(user);
        return res.json({ token, message: "Email verified successfully" });
    } catch (err: any) {
        return res.status(500).json({ error: "Internal Server Error" });
    }
});

// --- Password Reset ---
router.post("/reset-password/request", async (req: Request, res: Response) => {
    try {
        const { email } = req.body;
        if (!email) return res.status(400).json({ error: "Email is required" });

        const normalizedEmail = AuthService.normalizeEmail(email);
        const user = await AppDataSource.getRepository(User).findOneBy({ email: normalizedEmail });

        if (!user) {
            return res.json({ message: "If that address is registered, a reset code has been sent." });
        }

        const cooldownKey = `pwd_reset_cooldown:${normalizedEmail}`;
        const onCooldown = await redis.get(cooldownKey);
        if (onCooldown) {
            return res.status(429).json({ error: "Please wait before requesting another reset code." });
        }

        const otp = generateOtp();
        await storeOtp(`pwd_reset:${normalizedEmail}`, otp);
        await redis.set(cooldownKey, '1', 'EX', 60);
        await EmailService.sendPasswordResetOtp(normalizedEmail, otp);

        const response: any = { message: "Reset code sent. Valid for 10 minutes." };
        if (process.env.NODE_ENV !== 'production') {
            response.otp = otp;
        }
        return res.json(response);
    } catch (err: any) {
        return res.status(500).json({ error: "Internal Server Error" });
    }
});

router.post("/reset-password/confirm", async (req: Request, res: Response) => {
    try {
        const { email, otp, newPassword } = req.body;
        if (!email || !otp || !newPassword) {
            return res.status(400).json({ error: "email, otp, and newPassword are required" });
        }
        if (newPassword.length < 8) {
            return res.status(400).json({ error: "Password must be at least 8 characters" });
        }

        const normalizedEmail = AuthService.normalizeEmail(email);

        const attemptsKey = `pwd_reset_attempts:${normalizedEmail}`;
        const attempts = parseInt(await redis.get(attemptsKey) || '0');
        if (attempts >= 5) {
            return res.status(429).json({ error: "Too many failed attempts. Request a new code." });
        }

        const valid = await verifyAndConsumeOtp(`pwd_reset:${normalizedEmail}`, otp.toString());
        if (!valid) {
            await redis.set(attemptsKey, (attempts + 1).toString(), 'EX', 600);
            return res.status(400).json({ error: "Invalid or expired code" });
        }

        await redis.del(attemptsKey);
        await redis.del(`pwd_reset_cooldown:${normalizedEmail}`);

        const userRepo = AppDataSource.getRepository(User);
        const user = await userRepo.findOneBy({ email: normalizedEmail });
        if (!user) return res.status(404).json({ error: "User not found" });

        user.password = await AuthService.hashPassword(newPassword);
        await userRepo.save(user);

        const token = AuthService.generateToken(user);
        return res.json({ token, message: "Password updated successfully" });
    } catch (err: any) {
        return res.status(500).json({ error: "Internal Server Error" });
    }
});

export default router;

// --- Driver Specific Exports ---
export const driverAuthRouter = Router();
driverAuthRouter.post("/signup", (req, res) => handleSignup(req, res, UserRole.DRIVER));
driverAuthRouter.post("/login", handleLogin);
