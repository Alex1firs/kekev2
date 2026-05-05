import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { User } from "../models/User";
import dotenv from "dotenv";

dotenv.config();

const JWT_SECRET = process.env.JWT_SECRET || "default_secret_change_me_in_prod";

export class AuthService {
    static normalizeEmail(email: string): string {
        return email.trim().toLowerCase();
    }

    static validateEmail(email: string): boolean {
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    }

    static normalizePhone(phone: string): string {
        let cleaned = phone.replace(/\D/g, "");
        if (cleaned.startsWith("0")) {
            cleaned = "234" + cleaned.substring(1);
        }
        return cleaned;
    }

    static async hashPassword(password: string): Promise<string> {
        return await bcrypt.hash(password, 10);
    }

    static async comparePassword(password: string, hash: string): Promise<boolean> {
        return await bcrypt.compare(password, hash);
    }

    static generateToken(user: User): string {
        return jwt.sign(
            {
                userId: user.id,
                email: user.email,
                role: user.role,
                firstName: user.firstName,
                lastName: user.lastName
            },
            JWT_SECRET,
            { expiresIn: "30d" }
        );
    }
}
