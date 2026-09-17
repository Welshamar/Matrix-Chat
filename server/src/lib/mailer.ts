import nodemailer, { Transporter } from "nodemailer";
import { env } from "../config/env";

let transporter: Transporter | null = null;

function getTransporter(): Transporter {
  if (!env.GMAIL_USER || !env.GMAIL_APP_PASSWORD) {
    throw new Error("Email is not configured on this server (GMAIL_USER/GMAIL_APP_PASSWORD missing).");
  }
  if (!transporter) {
    transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: env.GMAIL_USER, pass: env.GMAIL_APP_PASSWORD },
    });
  }
  return transporter;
}

export async function sendVerificationEmail(to: string, code: string): Promise<void> {
  await getTransporter().sendMail({
    from: `"Matrix Chat" <${env.GMAIL_USER}>`,
    to,
    subject: "Your Matrix Chat verification code",
    text: `Your verification code is ${code}. It expires in 10 minutes.`,
    html: `
      <div style="font-family: Georgia, serif; max-width: 420px; margin: 0 auto;">
        <h2 style="margin-bottom: 4px;">🔒 Matrix Chat</h2>
        <p>Your verification code is:</p>
        <p style="font-size: 32px; font-weight: bold; letter-spacing: 6px;">${code}</p>
        <p style="color: #666;">This code expires in 10 minutes. If you didn't request this, you can ignore this email.</p>
      </div>
    `,
  });
}
