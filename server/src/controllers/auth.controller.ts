import { Request, Response } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { prisma } from "../db/prisma";
import { env } from "../config/env";
import { sendPasswordResetEmail, sendVerificationEmail } from "../lib/mailer";

const BCRYPT_ROUNDS = 12;
// Deliberately permissive: any script's letters, spaces, and punctuation are
// fine here (a username is a display handle, not a URL/filename identifier --
// every place it's used in a request path already goes through
// encodeURIComponent client-side). Only emoji and control characters are
// excluded -- emoji so it stays readable as plain text everywhere it's
// rendered, control characters so it can't break layout or hide content.
// Mirrored client-side in web/lib/username.ts for instant feedback; this is
// the actual enforcement point.
const USERNAME_MIN_LENGTH = 3;
const USERNAME_MAX_LENGTH = 32;
const EMOJI_PATTERN = /\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}/u;
const CONTROL_CHAR_PATTERN = /\p{Cc}/u;

function isValidUsername(raw: string): raw is string {
  const trimmed = raw.trim();
  return (
    trimmed.length >= USERNAME_MIN_LENGTH &&
    trimmed.length <= USERNAME_MAX_LENGTH &&
    !CONTROL_CHAR_PATTERN.test(trimmed) &&
    !EMOJI_PATTERN.test(trimmed)
  );
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VERIFICATION_CODE_TTL_MS = 10 * 60 * 1000;
const MAX_AVATAR_DATA_URL_LENGTH = 400_000; // ~300KB decoded — client resizes before upload
const AVATAR_DATA_URL_PATTERN = /^data:image\/(png|jpeg|jpg|webp);base64,/;
const MAX_STATUS_TEXT_LENGTH = 140;

function issueToken(userId: string): string {
  return jwt.sign({ sub: userId }, env.JWT_SECRET, { expiresIn: "30d" });
}

function generateVerificationCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function authResponse(user: { id: string; username: string; avatarUrl: string | null; statusText: string | null }) {
  return {
    userId: user.id,
    username: user.username,
    avatarUrl: user.avatarUrl,
    statusText: user.statusText,
    token: issueToken(user.id),
  };
}

export async function register(req: Request, res: Response): Promise<void> {
  const { email, password } = req.body as { username?: string; email?: string; password?: string };
  const rawUsername = req.body?.username as string | undefined;

  if (!rawUsername || !isValidUsername(rawUsername)) {
    res.status(400).json({ error: `Username must be ${USERNAME_MIN_LENGTH}-${USERNAME_MAX_LENGTH} characters, no emoji.` });
    return;
  }
  // Trimmed, not the raw field -- so " bob " and "bob" collide on the unique
  // constraint (as they should) instead of silently creating two accounts.
  const username = rawUsername.trim();
  if (!email || !EMAIL_PATTERN.test(email)) {
    res.status(400).json({ error: "Enter a valid email address." });
    return;
  }
  if (!password || password.length < 8) {
    res.status(400).json({ error: "Password must be at least 8 characters." });
    return;
  }

  const [existingUsername, existingEmail] = await Promise.all([
    prisma.user.findUnique({ where: { username } }),
    prisma.user.findUnique({ where: { email } }),
  ]);
  if (existingUsername) {
    res.status(409).json({ error: "Username is already taken." });
    return;
  }
  if (existingEmail) {
    res.status(409).json({ error: "An account with that email already exists." });
    return;
  }

  const code = generateVerificationCode();
  try {
    await sendVerificationEmail(email, code);
  } catch (err) {
    console.error("Failed to send verification email:", err);
    res.status(503).json({ error: "Couldn't send the verification email. Please try again." });
    return;
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const user = await prisma.user.create({
    data: {
      username,
      email,
      passwordHash,
      verificationCode: code,
      verificationCodeExpiresAt: new Date(Date.now() + VERIFICATION_CODE_TTL_MS),
    },
  });

  res.status(201).json({
    username: user.username,
    email: user.email,
    message: "Verification code sent — check your email.",
  });
}

/** POST /api/auth/verify-email — completes registration (or an interrupted
 *  login) by checking the 6-digit code and, on success, logging the user in. */
export async function verifyEmail(req: Request, res: Response): Promise<void> {
  const { username, code } = req.body as { username?: string; code?: string };

  if (!username || !code) {
    res.status(400).json({ error: "username and code are required." });
    return;
  }

  const user = await prisma.user.findUnique({ where: { username } });
  if (!user) {
    res.status(404).json({ error: "No account with that username." });
    return;
  }

  if (user.emailVerified) {
    res.json(authResponse(user));
    return;
  }

  if (user.verificationCode !== code) {
    res.status(400).json({ error: "Incorrect code." });
    return;
  }
  if (!user.verificationCodeExpiresAt || user.verificationCodeExpiresAt < new Date()) {
    res.status(400).json({ error: "That code has expired. Request a new one." });
    return;
  }

  const verified = await prisma.user.update({
    where: { id: user.id },
    data: { emailVerified: true, verificationCode: null, verificationCodeExpiresAt: null },
  });

  res.json(authResponse(verified));
}

/** POST /api/auth/resend-code — issues a fresh 10-minute code, e.g. after the
 *  previous one expired or the verification email never arrived. */
export async function resendCode(req: Request, res: Response): Promise<void> {
  const { username } = req.body as { username?: string };

  if (!username) {
    res.status(400).json({ error: "username is required." });
    return;
  }

  const user = await prisma.user.findUnique({ where: { username } });
  if (!user || !user.email) {
    res.status(404).json({ error: "No account with that username." });
    return;
  }
  if (user.emailVerified) {
    res.status(400).json({ error: "This account is already verified." });
    return;
  }

  const code = generateVerificationCode();
  try {
    await sendVerificationEmail(user.email, code);
  } catch (err) {
    console.error("Failed to send verification email:", err);
    res.status(503).json({ error: "Couldn't send the verification email. Please try again." });
    return;
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { verificationCode: code, verificationCodeExpiresAt: new Date(Date.now() + VERIFICATION_CODE_TTL_MS) },
  });

  res.json({ message: "Verification code sent — check your email." });
}

export async function login(req: Request, res: Response): Promise<void> {
  const { username, password } = req.body as { username?: string; password?: string };

  if (!username || !password) {
    res.status(400).json({ error: "username and password are required." });
    return;
  }

  const user = await prisma.user.findUnique({ where: { username } });
  if (!user) {
    res.status(401).json({ error: "Invalid username or password." });
    return;
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    res.status(401).json({ error: "Invalid username or password." });
    return;
  }

  // Accounts created before email verification existed have no email on
  // file and are grandfathered in — verification is only enforced for
  // accounts that registered with one.
  if (user.email && !user.emailVerified) {
    const code = generateVerificationCode();
    try {
      await sendVerificationEmail(user.email, code);
      await prisma.user.update({
        where: { id: user.id },
        data: { verificationCode: code, verificationCodeExpiresAt: new Date(Date.now() + VERIFICATION_CODE_TTL_MS) },
      });
    } catch (err) {
      console.error("Failed to send verification email:", err);
    }
    res.status(403).json({ error: "Email not verified.", username: user.username });
    return;
  }

  res.json(authResponse(user));
}

/** POST /api/auth/forgot-password — requires both the username and the
 *  account's email to match (not just one), and issues a single generic
 *  error either way rather than saying which one was wrong -- otherwise
 *  this endpoint would let someone probe a username and an email
 *  separately to find a valid pair. */
export async function forgotPassword(req: Request, res: Response): Promise<void> {
  const { username, email } = req.body as { username?: string; email?: string };

  if (!username || !email) {
    res.status(400).json({ error: "username and email are required." });
    return;
  }

  const user = await prisma.user.findUnique({ where: { username } });
  if (!user || !user.email || user.email !== email) {
    res.status(404).json({ error: "No account matches that username and email." });
    return;
  }

  const code = generateVerificationCode();
  try {
    await sendPasswordResetEmail(user.email, code);
  } catch (err) {
    console.error("Failed to send password reset email:", err);
    res.status(503).json({ error: "Couldn't send the reset email. Please try again." });
    return;
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { passwordResetCode: code, passwordResetCodeExpiresAt: new Date(Date.now() + VERIFICATION_CODE_TTL_MS) },
  });

  res.json({ username: user.username, message: "Reset code sent — check your email." });
}

/** POST /api/auth/reset-password — completes the flow above: checks the
 *  6-digit code and, on success, sets the new password and logs the
 *  person straight in (same "verify, then land in the app" shape as
 *  verifyEmail above). */
export async function resetPassword(req: Request, res: Response): Promise<void> {
  const { username, code, newPassword } = req.body as { username?: string; code?: string; newPassword?: string };

  if (!username || !code || !newPassword) {
    res.status(400).json({ error: "username, code and newPassword are required." });
    return;
  }
  if (newPassword.length < 8) {
    res.status(400).json({ error: "Password must be at least 8 characters." });
    return;
  }

  const user = await prisma.user.findUnique({ where: { username } });
  if (!user) {
    res.status(404).json({ error: "No account with that username." });
    return;
  }
  if (!user.passwordResetCode || user.passwordResetCode !== code) {
    res.status(400).json({ error: "Incorrect code." });
    return;
  }
  if (!user.passwordResetCodeExpiresAt || user.passwordResetCodeExpiresAt < new Date()) {
    res.status(400).json({ error: "That code has expired. Request a new one." });
    return;
  }

  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash, passwordResetCode: null, passwordResetCodeExpiresAt: null },
  });

  res.json(authResponse(updated));
}

/** GET /api/auth/lookup/:username — resolve a username to a userId to start a chat. */
export async function lookupUsername(req: Request, res: Response): Promise<void> {
  const { username } = req.params;
  const user = await prisma.user.findUnique({
    where: { username },
    select: { id: true, username: true, avatarUrl: true, statusText: true },
  });

  if (!user) {
    res.status(404).json({ error: "No user with that username." });
    return;
  }

  res.json({ userId: user.id, username: user.username, avatarUrl: user.avatarUrl, statusText: user.statusText });
}

/** GET /api/auth/resolve/:userId — resolve a userId back to a username (e.g. for an inbound message from an unknown sender). */
export async function resolveUserId(req: Request, res: Response): Promise<void> {
  const { userId } = req.params;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, username: true, avatarUrl: true, statusText: true },
  });

  if (!user) {
    res.status(404).json({ error: "No user with that id." });
    return;
  }

  res.json({ userId: user.id, username: user.username, avatarUrl: user.avatarUrl, statusText: user.statusText });
}

/** PATCH /api/auth/profile — update your own avatar and/or status text. */
export async function updateProfile(req: Request, res: Response): Promise<void> {
  const userId = req.userId!;
  const { avatarUrl, statusText } = req.body as { avatarUrl?: string | null; statusText?: string | null };

  const data: { avatarUrl?: string | null; statusText?: string | null } = {};

  if (avatarUrl !== undefined) {
    if (avatarUrl !== null) {
      if (avatarUrl.length > MAX_AVATAR_DATA_URL_LENGTH || !AVATAR_DATA_URL_PATTERN.test(avatarUrl)) {
        res.status(400).json({ error: "avatarUrl must be a small png/jpeg/webp data URL (resize before upload)." });
        return;
      }
    }
    data.avatarUrl = avatarUrl;
  }

  if (statusText !== undefined) {
    if (statusText !== null && statusText.length > MAX_STATUS_TEXT_LENGTH) {
      res.status(400).json({ error: `statusText must be ${MAX_STATUS_TEXT_LENGTH} characters or fewer.` });
      return;
    }
    data.statusText = statusText;
  }

  const user = await prisma.user.update({ where: { id: userId }, data });

  res.json({ userId: user.id, username: user.username, avatarUrl: user.avatarUrl, statusText: user.statusText });
}

/** DELETE /api/auth/account — permanently deletes the calling account and
 *  everything tied to it (messages, keys, group memberships, attachments --
 *  all cascade off the User row; see prisma/schema.prisma) after confirming
 *  the current password, so a leaked/stolen token alone isn't enough to
 *  destroy the account. Irreversible; there is no undo. */
export async function deleteAccount(req: Request, res: Response): Promise<void> {
  const userId = req.userId!;
  const { password } = req.body as { password?: string };

  if (!password) {
    res.status(400).json({ error: "password is required." });
    return;
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    res.status(404).json({ error: "Account not found." });
    return;
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    res.status(401).json({ error: "Incorrect password." });
    return;
  }

  await prisma.user.delete({ where: { id: userId } });
  res.json({ ok: true });
}

/** POST /api/auth/push-token — registers this device's FCM token so
 *  signal.gateway.ts can push a notification when this user has no live
 *  socket connection. One device at a time; re-registering overwrites it. */
export async function registerPushToken(req: Request, res: Response): Promise<void> {
  const userId = req.userId!;
  const { fcmToken } = req.body as { fcmToken?: string };

  if (!fcmToken) {
    res.status(400).json({ error: "fcmToken is required." });
    return;
  }

  await prisma.user.update({ where: { id: userId }, data: { fcmToken } });
  res.json({ ok: true });
}
