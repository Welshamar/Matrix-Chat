import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy Policy — Matrix Chat",
  description: "What Matrix Chat collects, what it never sees, and how to delete your data.",
};

const EFFECTIVE_DATE = "September 24, 2026";
const CONTACT_EMAIL = "kibwotawelborn3@gmail.com";

export default function PrivacyPolicyPage() {
  return (
    <div className="legal-shell">
      <div className="legal-doc">
        <Link href="/" className="legal-back">
          ← Matrix Chat
        </Link>
        <h1>Privacy Policy</h1>
        <p className="legal-effective">Effective {EFFECTIVE_DATE}</p>

        <p>
          Matrix Chat is an end-to-end encrypted messaging app. This policy explains what information the app and
          its server collect, what they never see, who else (if anyone) that information passes through, and how
          you can delete it.
        </p>

        <h2>The short version</h2>
        <ul>
          <li>
            Your messages, voice notes, photos, and files are end-to-end encrypted (the Signal Protocol) before
            they leave your device. The server stores and relays only unreadable encrypted bytes — it cannot read
            your conversations, and neither can we.
          </li>
          <li>Your encryption keys are generated on your device and never leave it.</li>
          <li>
            We do collect some account information (below) to make the app work — a username, an email address,
            and a few optional profile details.
          </li>
          <li>You can permanently delete your account and everything tied to it at any time, from inside the app.</li>
        </ul>

        <h2>Information we collect</h2>
        <p>To create and operate your account, we collect:</p>
        <ul>
          <li>
            <strong>Username</strong> — your chosen display handle.
          </li>
          <li>
            <strong>Email address</strong> — used only to send you a one-time verification code when you register,
            and a one-time reset code if you use "Forgot password." We don&apos;t send marketing email and don&apos;t
            share your email with other users.
          </li>
          <li>
            <strong>Password</strong> — stored as a salted cryptographic hash (bcrypt). We never store, and cannot
            recover, your actual password.
          </li>
          <li>
            <strong>Profile picture and status text</strong> — optional, shown to people you chat with.
          </li>
          <li>
            <strong>Online / last-seen status</strong> — whether you&apos;re currently connected, and when you were
            last seen, shown to people you chat with.
          </li>
          <li>
            <strong>Push notification token</strong> (Android app only) — lets the app notify you of a new message
            when it isn&apos;t open. Provided by Firebase Cloud Messaging (Google) — see below.
          </li>
        </ul>

        <h2>What we never see</h2>
        <p>
          Message text, voice notes, photos, and files are encrypted on your device before sending, using keys that
          are also generated and stored on your device and never transmitted anywhere. The server only ever handles
          the resulting opaque encrypted bytes:
        </p>
        <ul>
          <li>
            Small messages and voice notes travel inside the encrypted message itself and are deleted from the
            server as soon as they&apos;re delivered to you (or immediately after being viewed, for a "view once"
            photo).
          </li>
          <li>
            Larger files and videos are separately encrypted on your device with a random key that only travels
            inside the encrypted message to its recipient — the server stores only the encrypted file bytes, and
            automatically deletes them after 14 days (or sooner, once no longer needed).
          </li>
          <li>Call audio and video flow directly between devices (or through a relay, see below), encrypted end-to-end — the server never touches it.</li>
        </ul>

        <h2>Who else this data passes through</h2>
        <p>Running the app requires a few infrastructure providers. None of them can read your message content.</p>
        <ul>
          <li>
            <strong>Database and server hosting</strong> (Neon, Render) — store account details and the encrypted
            data described above.
          </li>
          <li>
            <strong>Web hosting</strong> (Vercel) — serves the app itself.
          </li>
          <li>
            <strong>Email delivery</strong> — sends the verification/reset code emails described above; sees your
            email address and that one-time code, nothing else.
          </li>
          <li>
            <strong>Push notifications</strong> (Firebase Cloud Messaging, Google) — Android only, delivers a
            generic "you have a new message" notification; sees a device token, not message content.
          </li>
          <li>
            <strong>Call relay</strong> (a TURN relay) — used only when two devices can&apos;t connect directly for
            a call; relays encrypted audio/video without being able to decrypt it, and sees the IP addresses
            involved.
          </li>
        </ul>

        <h2>Your rights and choices</h2>
        <ul>
          <li>
            <strong>Delete your account</strong> at any time from Profile → Delete account. This permanently and
            immediately deletes your account, your messages, your encryption keys, your group memberships, and any
            files you&apos;ve sent — there is no way to undo this, and no backup is kept.
          </li>
          <li>You can update your profile picture and status text at any time.</li>
          <li>You can contact us (below) with any question or request about your data.</li>
        </ul>

        <h2>Children&apos;s privacy</h2>
        <p>Matrix Chat is not directed at children under 13, and we do not knowingly collect information from them.</p>

        <h2>Changes to this policy</h2>
        <p>
          If this policy changes, the "Effective" date above will be updated. Continued use of the app after a
          change means you accept the updated policy.
        </p>

        <h2>Contact</h2>
        <p>
          Questions, requests, or concerns about your data:{" "}
          <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
        </p>
      </div>
    </div>
  );
}
