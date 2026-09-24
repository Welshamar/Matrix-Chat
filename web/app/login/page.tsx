"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { EmailNotVerifiedError, login } from "@/lib/api";
import { saveSession } from "@/lib/auth";
import { VerifyCodeForm } from "@/components/VerifyCodeForm";

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [pendingUsername, setPendingUsername] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await login(username.trim(), password);
      saveSession(res);
      router.push("/chat");
    } catch (err) {
      if (err instanceof EmailNotVerifiedError) {
        setPendingUsername(err.username);
      } else {
        setError(err instanceof Error ? err.message : "Login failed.");
      }
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

        {pendingUsername ? (
          <VerifyCodeForm
            username={pendingUsername}
            onVerified={(session) => {
              saveSession(session);
              router.push("/chat");
            }}
            onBack={() => setPendingUsername(null)}
          />
        ) : (
          <>
            <p className="auth-subtitle">End-to-end encrypted with the Signal Protocol.</p>

            {error && <div className="error-banner">{error}</div>}

            <form onSubmit={handleSubmit}>
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
                <label htmlFor="password">Password</label>
                <input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  required
                />
              </div>
              <p className="auth-forgot-link">
                <Link href="/forgot-password">Forgot password?</Link>
              </p>
              <button className="btn-primary" type="submit" disabled={submitting}>
                {submitting ? "Signing in..." : "Sign in"}
              </button>
            </form>

            <p className="auth-switch">
              No account? <Link href="/register">Create one</Link>
            </p>
          </>
        )}
      </div>
    </div>
  );
}
