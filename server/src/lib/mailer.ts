import nodemailer, { Transporter } from "nodemailer";
import { env } from "../config/env";

// Every option here needs one thing only the account owner can produce (an
// app password, an API key, a domain's DNS records) -- there's no way to
// send email as someone/something without proving that, whichever provider
// is used. Two are wired up so whichever is easier to actually finish
// (Gmail needs 2-Step Verification + an App Password; SendGrid needs only
// clicking a verification link SendGrid emails to the sender address) can
// be used, without waiting on the other.

interface EmailContent {
  subject: string;
  text: string;
  html: string;
}

function codeEmail(subject: string, intro: string, code: string): EmailContent {
  return {
    subject,
    text: `${intro} ${code}. It expires in 10 minutes.`,
    html: `
      <div style="font-family: Georgia, serif; max-width: 420px; margin: 0 auto;">
        <h2 style="margin-bottom: 4px;">🔒 Matrix Chat</h2>
        <p>${intro}</p>
        <p style="font-size: 32px; font-weight: bold; letter-spacing: 6px;">${code}</p>
        <p style="color: #666;">This code expires in 10 minutes. If you didn't request this, you can ignore this email -- your account is unaffected.</p>
      </div>
    `,
  };
}

// --- Gmail SMTP (via an App Password, not the account's login password) ---
// Gmail carries its own sending reputation, so unlike a fresh transactional-
// email account it can mail any address from day one -- no domain to verify.
// Trade-off: Gmail's own sending caps (~500/day) apply, irrelevant at this
// app's scale. Raw SMTP is blocked outbound by some free PaaS tiers to stop
// spam relay abuse (confirmed blocked on Render's free tier) -- SendGrid (a
// plain HTTPS call) works around that.
let gmailTransporter: Transporter | null = null;

async function sendViaGmail(to: string, content: EmailContent): Promise<void> {
  if (!gmailTransporter) {
    gmailTransporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: env.GMAIL_USER, pass: env.GMAIL_APP_PASSWORD },
    });
  }
  await gmailTransporter.sendMail({ from: `Matrix Chat <${env.GMAIL_USER}>`, to, ...content });
}

// --- SendGrid (plain HTTPS call, no SDK dependency needed) ---
// Only needs the `from` address to pass Single Sender Verification (click
// the link SendGrid emails to it) -- no domain, no DNS records, no 2FA
// prerequisite. https://app.sendgrid.com/settings/sender_auth. Without full
// Domain Authentication, mail sent "from" a gmail.com address through a
// third party (rather than Google's own servers) commonly lands in spam --
// expected until SENDGRID_FROM_EMAIL is on a domain SendGrid has verified.
async function sendViaSendGrid(to: string, content: EmailContent): Promise<void> {
  const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.SENDGRID_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: env.SENDGRID_FROM_EMAIL, name: "Matrix Chat" },
      subject: content.subject,
      content: [
        { type: "text/plain", value: content.text },
        { type: "text/html", value: content.html },
      ],
    }),
  });
  if (!res.ok) {
    // SendGrid's error body is JSON ({errors: [{message, field, help}]}), a
    // lot more specific than the bare HTTP status -- e.g. exactly which
    // address still needs Single Sender Verification.
    const body = await res.text().catch(() => "");
    throw new Error(`SendGrid ${res.status}: ${body || res.statusText}`);
  }
}

async function sendEmail(to: string, content: EmailContent): Promise<void> {
  try {
    if (env.GMAIL_USER && env.GMAIL_APP_PASSWORD) {
      await sendViaGmail(to, content);
    } else if (env.SENDGRID_API_KEY && env.SENDGRID_FROM_EMAIL) {
      await sendViaSendGrid(to, content);
    } else {
      throw new Error(
        "Email is not configured on this server (set GMAIL_USER + GMAIL_APP_PASSWORD, or SENDGRID_API_KEY + SENDGRID_FROM_EMAIL)."
      );
    }
  } catch (err) {
    // The caller only shows the person a generic "couldn't send" message
    // (right thing to do -- a raw provider error isn't useful to someone
    // registering) and logs whatever this throws, so the actual reason
    // needs to survive into that log rather than being reduced to a bare
    // "Failed to send email." Nodemailer's errors carry an SMTP
    // response code/text (e.g. "535 Username and Password not accepted"
    // for a stale app password) in .response, not always in .message.
    const detail = err instanceof Error ? [err.message, (err as { response?: string }).response].filter(Boolean).join(" — ") : String(err);
    throw new Error(detail || "Failed to send email.");
  }
}

export function sendVerificationEmail(to: string, code: string): Promise<void> {
  return sendEmail(to, codeEmail("Your Matrix Chat verification code", "Your verification code is", code));
}

export function sendPasswordResetEmail(to: string, code: string): Promise<void> {
  return sendEmail(to, codeEmail("Your Matrix Chat password reset code", "Your password reset code is", code));
}
