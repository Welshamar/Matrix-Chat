import "dotenv/config";

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const env = {
  PORT: Number(process.env.PORT ?? 4000),
  DATABASE_URL: required("DATABASE_URL"),
  JWT_SECRET: required("JWT_SECRET"),
  CORS_ORIGIN: process.env.CORS_ORIGIN ?? "*",
  // Not required() — missing either shouldn't crash the whole server, just
  // registration's verification-email step (see lib/mailer.ts). GMAIL_USER
  // is the sending Gmail address; GMAIL_APP_PASSWORD is a 16-character App
  // Password generated for it (Google Account > Security > App Passwords
  // -- needs 2-Step Verification turned on first), never the account's own
  // login password.
  GMAIL_USER: process.env.GMAIL_USER,
  GMAIL_APP_PASSWORD: process.env.GMAIL_APP_PASSWORD,
  // Alternative to the above, tried if the Gmail pair isn't set. A
  // Single-Sender-Verified address (no domain needed) plus its API key --
  // https://app.sendgrid.com/settings/sender_auth.
  SENDGRID_API_KEY: process.env.SENDGRID_API_KEY,
  SENDGRID_FROM_EMAIL: process.env.SENDGRID_FROM_EMAIL,
  // The full Firebase service account key JSON, as one string. Missing
  // this only disables push notifications (see lib/push.ts) — everything
  // else keeps working over the existing socket connection.
  FIREBASE_SERVICE_ACCOUNT_JSON: process.env.FIREBASE_SERVICE_ACCOUNT_JSON,
};
