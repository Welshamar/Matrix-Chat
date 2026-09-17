import { useEffect, useState } from "react";
import { AuthResponse, resendCode, verifyEmail } from "@/lib/api";

const CODE_TTL_SECONDS = 10 * 60;

function formatCountdown(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

interface VerifyCodeFormProps {
  username: string;
  email?: string;
  onVerified: (session: AuthResponse) => void;
  onBack: () => void;
}

export function VerifyCodeForm({ username, email, onVerified, onBack }: VerifyCodeFormProps) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [resending, setResending] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(CODE_TTL_SECONDS);

  useEffect(() => {
    const interval = setInterval(() => setSecondsLeft((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(interval);
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setSubmitting(true);
    try {
      const session = await verifyEmail(username, code.trim());
      onVerified(session);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Verification failed.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleResend() {
    setError(null);
    setNotice(null);
    setResending(true);
    try {
      await resendCode(username);
      setNotice("A new code is on its way.");
      setSecondsLeft(CODE_TTL_SECONDS);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't resend the code.");
    } finally {
      setResending(false);
    }
  }

  const expired = secondsLeft === 0;

  return (
    <>
      <p className="auth-subtitle">
        {email ? (
          <>
            We sent a 6-digit code to <strong>{email}</strong>.
          </>
        ) : (
          "We sent a 6-digit code to your email."
        )}{" "}
        Enter it below to continue.
      </p>

      {error && <div className="error-banner">{error}</div>}
      {notice && !error && <div className="notice-banner">{notice}</div>}

      <form onSubmit={handleSubmit}>
        <div className="field">
          <label htmlFor="code">Verification code</label>
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
        <button className="btn-primary" type="submit" disabled={submitting || expired}>
          {submitting ? "Verifying..." : "Verify"}
        </button>
      </form>

      <p className="auth-switch">
        Didn&apos;t get it?{" "}
        <button type="button" className="link-btn" onClick={handleResend} disabled={resending}>
          {resending ? "Sending..." : "Resend code"}
        </button>
      </p>
      <p className="auth-switch">
        <button type="button" className="link-btn" onClick={onBack}>
          Back
        </button>
      </p>
    </>
  );
}
