import nodemailer from "nodemailer";
import dotenv from "dotenv";

dotenv.config();

const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || "smtp.gmail.com",
    port: parseInt(process.env.SMTP_PORT || "587"),
    secure: process.env.SMTP_SECURE === "true",
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
    },
});

const FROM_ADDRESS = process.env.SMTP_FROM || "noreply@kekeride.ng";

export class EmailService {
    static async sendVerificationOtp(email: string, otp: string): Promise<void> {
        if (!process.env.SMTP_USER) return; // Skip in dev if SMTP not configured
        await transporter.sendMail({
            from: `"Keke Ride" <${FROM_ADDRESS}>`,
            to: email,
            subject: "Verify your Keke account",
            text: `Your Keke verification code is: ${otp}\n\nThis code expires in 10 minutes.`,
            html: `
                <div style="font-family:sans-serif;max-width:480px;margin:auto">
                    <h2 style="color:#1a1a2e">Verify your Keke account</h2>
                    <p>Use the code below to verify your email address:</p>
                    <div style="background:#f5f5f5;border-radius:8px;padding:24px;text-align:center;margin:24px 0">
                        <span style="font-size:36px;font-weight:700;letter-spacing:8px;color:#1a1a2e">${otp}</span>
                    </div>
                    <p style="color:#666">This code expires in <strong>10 minutes</strong>.</p>
                    <p style="color:#999;font-size:12px">If you didn't create a Keke account, ignore this email.</p>
                </div>
            `,
        });
    }

    static async sendPasswordResetOtp(email: string, otp: string): Promise<void> {
        if (!process.env.SMTP_USER) return;
        await transporter.sendMail({
            from: `"Keke Ride" <${FROM_ADDRESS}>`,
            to: email,
            subject: "Reset your Keke password",
            text: `Your Keke password reset code is: ${otp}\n\nThis code expires in 10 minutes.`,
            html: `
                <div style="font-family:sans-serif;max-width:480px;margin:auto">
                    <h2 style="color:#1a1a2e">Reset your Keke password</h2>
                    <p>Use the code below to reset your password:</p>
                    <div style="background:#f5f5f5;border-radius:8px;padding:24px;text-align:center;margin:24px 0">
                        <span style="font-size:36px;font-weight:700;letter-spacing:8px;color:#1a1a2e">${otp}</span>
                    </div>
                    <p style="color:#666">This code expires in <strong>10 minutes</strong>.</p>
                    <p style="color:#999;font-size:12px">If you didn't request a password reset, ignore this email.</p>
                </div>
            `,
        });
    }
}
