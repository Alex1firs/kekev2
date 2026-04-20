import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { User, UserRole } from "../models/User";
import dotenv from "dotenv";

dotenv.config();

const JWT_SECRET = process.env.JWT_SECRET || "default_secret_change_me_in_prod";

export class AuthService {
    /**
     * Normalize phone numbers to a consistent digit-only format.
     * E.g., +234 801 234 5678 -> 2348012345678
     *       0801 234 5678 -> 2348012345678 (Nigerian context)
     */
    static normalizePhone(phone: string): string {
        let cleaned = phone.replace(/\D/g, "");
        if (cleaned.startsWith("0")) {
            cleaned = "234" + cleaned.substring(1);
        }
        return cleaned;
    }

    /**
     * Hash password for secure storage
     */
    static async hashPassword(password: string): Promise<string> {
        return await bcrypt.hash(password, 10);
    }

    /**
     * Compare raw password with stored hash
     */
    static async comparePassword(password: string, hash: string): Promise<boolean> {
        return await bcrypt.compare(password, hash);
    }

    /**
     * Generate 30-day JWT for pilot use
     */
    static generateToken(user: User): string {
        return jwt.sign(
            { 
                userId: user.id, 
                phone: user.phone, 
                role: user.role,
                firstName: user.firstName,
                lastName: user.lastName
            }, 
            JWT_SECRET, 
            { expiresIn: "30d" }
        );
    }
}
