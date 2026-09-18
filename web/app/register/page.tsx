"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { register } from "@/lib/api";
import { saveSession } from "@/lib/auth";
import { VerifyCodeForm } from "@/components/VerifyCodeForm";

export default function RegisterPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [pending, setPending] = useState<{ username: string; email: string } | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await register(username.trim(), email.trim(), password);
      setPending({ username: res.username, email: res.email });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Registration failed.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <h1 className="auth-title">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="auth-title-logo" src="/logo/matrix-chat-mark.svg" alt="" aria-hidden="true" />
          Matrix Chat
        </h1>

        {pending ? (
          <VerifyCodeForm
            username={pending.username}
            email={pending.email}
            onVerified={(session) => {
              saveSession(session);
              router.push("/chat");
            }}
            onBack={() => setPending(null)}
          />
        ) : (
          <>
            <p className="auth-subtitle">
              Create an account. Your keys are generated on this device and never leave it.
            </p>

            {error && <div className="error-banner">{error}</div>}

            <form onSubmit={handleSubmit}>
              <div className="field">
                <label htmlFor="username">Username</label>
                <input
                  id="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="username"
                  minLength={3}
                  maxLength={32}
                  pattern="[a-zA-Z0-9_.\-]+"
                  title="Letters, numbers, _ . - only"
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
              <div className="field">
                <label htmlFor="password">Password</label>
                <input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                  minLength={8}
                  required
                />
              </div>
              <button className="btn-primary" type="submit" disabled={submitting}>
                {submitting ? "Creating account..." : "Create account"}
              </button>
            </form>

            <p className="auth-switch">
              Already have an account? <Link href="/login">Sign in</Link>
            </p>
          </>
        )}
      </div>
    </div>
  );
}
