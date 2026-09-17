import { Resend } from "resend";
import { env } from "../config/env";

let client: Resend | null = null;

function getClient(): Resend {
  if (!env.RESEND_API_KEY) {
    throw new Error("Email is not configured on this server (RESEND_API_KEY missing).");
  }
  if (!client) {
    client = new Resend(env.RESEND_API_KEY);
  }
  return client;
}

export async function sendVerificationEmail(to: string, code: string): Promise<void> {
  const { error } = await getClient().emails.send({
    // onboarding@resend.dev is Resend's shared sandbox sender — it works
    // without owning/verifying a domain, but until a real domain is
    // verified in Resend it can only deliver to the Resend account's own
    // (sign-up) email address, not to arbitrary registering users.
    from: "Matrix Chat <onboarding@resend.dev>",
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

  if (error) {
    throw new Error(error.message);
  }
}
