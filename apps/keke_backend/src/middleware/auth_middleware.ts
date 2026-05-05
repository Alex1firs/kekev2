import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";

dotenv.config();

const _jwtSecret = process.env.JWT_SECRET;
if (!_jwtSecret) {
    throw new Error('FATAL: JWT_SECRET environment variable is not set. Refusing to start.');
}
const JWT_SECRET: string = _jwtSecret;

export interface AuthRequest extends Request {
    user?: {
        userId: string;
        email: string;
        role: string;
    };
}

export const authMiddleware = (req: AuthRequest, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(401).json({ error: "Access denied. No token provided." });
    }

    const token = authHeader.split(" ")[1];

    try {
        const decoded = jwt.verify(token, JWT_SECRET) as any;
        req.user = decoded;
        next();
    } catch (err) {
        return res.status(401).json({ error: "Invalid or expired token." });
    }
};
