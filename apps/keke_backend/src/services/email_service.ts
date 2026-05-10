import { Resend } from "resend";

const resend = process.env.RESEND_API_KEY
    ? new Resend(process.env.RESEND_API_KEY)
    : null;

const FROM_ADDRESS = process.env.SMTP_FROM || "noreply@kekeride.ng";

function buildOtpEmail({
    title,
    subtitle,
    otp,
    disclaimer,
}: {
    title: string;
    subtitle: string;
    otp: string;
    disclaimer: string;
}): string {
    return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>${title}</title></head>
<body style="margin:0;padding:0;background-color:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f5;padding:40px 16px;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;">

          <!-- Header -->
          <tr>
            <td style="background-color:#1a1a2e;border-radius:16px 16px 0 0;padding:32px 40px;text-align:center;">
              <table cellpadding="0" cellspacing="0" style="margin:0 auto;">
                <tr>
                  <td style="background-color:#f5c518;border-radius:12px;padding:8px 16px;display:inline-block;">
                    <span style="font-size:22px;font-weight:800;color:#1a1a2e;letter-spacing:1px;">&#9889; Keke Ride</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="background-color:#ffffff;padding:40px 40px 32px;">
              <h1 style="margin:0 0 8px;font-size:22px;font-weight:700;color:#1a1a2e;">${title}</h1>
              <p style="margin:0 0 28px;font-size:15px;color:#6b7280;">${subtitle}</p>

              <!-- OTP Box -->
              <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px;">
                <tr>
                  <td style="background-color:#f9fafb;border:2px dashed #e5e7eb;border-radius:12px;padding:28px 20px;text-align:center;">
                    <p style="margin:0 0 6px;font-size:12px;font-weight:600;color:#9ca3af;letter-spacing:2px;text-transform:uppercase;">Your verification code</p>
                    <span style="font-size:44px;font-weight:800;letter-spacing:12px;color:#1a1a2e;font-variant-numeric:tabular-nums;">${otp}</span>
                  </td>
                </tr>
              </table>

              <!-- Expiry notice -->
              <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
                <tr>
                  <td style="background-color:#fef9c3;border-radius:8px;padding:12px 16px;">
                    <p style="margin:0;font-size:13px;color:#92400e;">
                      &#8987; This code expires in <strong>10 minutes</strong>. Do not share it with anyone.
                    </p>
                  </td>
                </tr>
              </table>

              <p style="margin:0;font-size:13px;color:#9ca3af;">${disclaimer}</p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color:#f9fafb;border-radius:0 0 16px 16px;padding:24px 40px;text-align:center;border-top:1px solid #e5e7eb;">
              <p style="margin:0 0 4px;font-size:12px;color:#9ca3af;">Sent by <strong style="color:#1a1a2e;">Keke Ride</strong> &mdash; Nigeria&rsquo;s smart keke booking platform</p>
              <p style="margin:0;font-size:11px;color:#d1d5db;">kekeride.ng &nbsp;&bull;&nbsp; noreply@kekeride.ng</p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export class EmailService {
    static async sendVerificationOtp(email: string, otp: string): Promise<void> {
        if (!resend) return;
        await resend.emails.send({
            from: `Keke Ride <${FROM_ADDRESS}>`,
            to: email,
            subject: "Your Keke verification code",
            text: `Your Keke verification code is: ${otp}\n\nThis code expires in 10 minutes. Do not share it with anyone.`,
            html: buildOtpEmail({
                title: "Verify your email address",
                subtitle: "Enter the code below in the Keke Ride app to verify your account and start booking rides.",
                otp,
                disclaimer: "If you didn't create a Keke Ride account, you can safely ignore this email.",
            }),
        });
    }

    static async sendPasswordResetOtp(email: string, otp: string): Promise<void> {
        if (!resend) return;
        await resend.emails.send({
            from: `Keke Ride <${FROM_ADDRESS}>`,
            to: email,
            subject: "Reset your Keke password",
            text: `Your Keke password reset code is: ${otp}\n\nThis code expires in 10 minutes. Do not share it with anyone.`,
            html: buildOtpEmail({
                title: "Reset your password",
                subtitle: "Enter the code below in the Keke Ride app to set a new password for your account.",
                otp,
                disclaimer: "If you didn't request a password reset, ignore this email. Your password will not change.",
            }),
        });
    }
}
