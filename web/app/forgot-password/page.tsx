"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { forgotPassword, resetPassword } from "@/lib/api";
import { saveSession } from "@/lib/auth";

const CODE_TTL_SECONDS = 10 * 60;

function formatCountdown(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function ForgotPasswordPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [resending, setResending] = useState(false);
  // Set once the reset code has actually been sent -- switches the form
  // from "who are you" to "here's the code + your new password".
  const [pending, setPending] = useState<{ username: string; email: string } | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(CODE_TTL_SECONDS);

  useEffect(() => {
    if (!pending) return;
    const interval = setInterval(() => setSecondsLeft((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(interval);
  }, [pending]);

  async function handleRequestCode(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await forgotPassword(username.trim(), email.trim());
      setPending({ username: res.username, email: email.trim() });
      setSecondsLeft(CODE_TTL_SECONDS);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't send a reset code.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleResetPassword(e: React.FormEvent) {
    e.preventDefault();
    if (!pending) return;
    setError(null);
    setSubmitting(true);
    try {
      const session = await resetPassword(pending.username, code.trim(), newPassword);
      saveSession(session);
      router.push("/chat");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't reset your password.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleResend() {
    if (!pending) return;
    setError(null);
    setNotice(null);
    setResending(true);
    try {
      await forgotPassword(pending.username, pending.email);
      setNotice("A new code is on its way.");
      setSecondsLeft(CODE_TTL_SECONDS);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't resend the code.");
    } finally {
      setResending(false);
    }
  }

  const expired = pending !== null && secondsLeft === 0;

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <h1 className="auth-title">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="auth-title-logo" src="/logo/matrix-chat-mark.svg" alt="" aria-hidden="true" />
          Matrix Chat
        </h1>

        {pending ? (
          <>
            <p className="auth-subtitle">
              We sent a 6-digit code to <strong>{pending.email}</strong>. Enter it below with your new password.
            </p>

            {error && <div className="error-banner">{error}</div>}
            {notice && !error && <div className="notice-banner">{notice}</div>}

            <form onSubmit={handleResetPassword}>
              <div className="field">
                <label htmlFor="code">Reset code</label>
                <input
                  id="code"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  autoComplete="one-time-code"
                  required
                />
              </div>
              <p className="auth-code-expiry">
                {expired ? "This code has expired." : `Code expires in ${formatCountdown(secondsLeft)}`}
              </p>
              <div className="field">
                <label htmlFor="newPassword">New password</label>
                <input
                  id="newPassword"
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  autoComplete="new-password"
                  minLength={8}
                  required
                />
              </div>
              <button className="btn-primary" type="submit" disabled={submitting || expired}>
                {submitting ? "Resetting..." : "Reset password"}
              </button>
            </form>

            <p className="auth-switch">
              Didn&apos;t get it?{" "}
              <button type="button" className="link-btn" onClick={handleResend} disabled={resending}>
                {resending ? "Sending..." : "Resend code"}
              </button>
            </p>
            <p className="auth-switch">
              <button type="button" className="link-btn" onClick={() => setPending(null)}>
                Back
              </button>
            </p>
          </>
        ) : (
          <>
            <p className="auth-subtitle">
              Enter your username and the email you registered with, and we&apos;ll send a code to reset your
              password.
            </p>

            {error && <div className="error-banner">{error}</div>}

            <form onSubmit={handleRequestCode}>
              <div className="field">
                <label htmlFor="username">Username</label>
                <input
                  id="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="username"
                  required
                />
              </div>
              <div className="field">
                <label htmlFor="email">Email</label>
                <input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="email"
                  required
                />
              </div>
              <button className="btn-primary" type="submit" disabled={submitting}>
                {submitting ? "Sending..." : "Send reset code"}
              </button>
            </form>

            <p className="auth-switch">
              <Link href="/login">Back to sign in</Link>
            </p>
          </>
        )}
      </div>
    </div>
  );
}
