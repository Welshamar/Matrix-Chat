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
  // Not required() — missing this shouldn't crash the whole server, just
  // registration's verification-email step (see lib/mailer.ts).
  RESEND_API_KEY: process.env.RESEND_API_KEY,
};
