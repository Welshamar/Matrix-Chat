import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Terms of Service — Matrix Chat",
  description: "The terms that apply to using Matrix Chat.",
};

const EFFECTIVE_DATE = "September 24, 2026";
const CONTACT_EMAIL = "kibwotawelborn3@gmail.com";

export default function TermsPage() {
  return (
    <div className="legal-shell">
      <div className="legal-doc">
        <Link href="/" className="legal-back">
          ← Matrix Chat
        </Link>
        <h1>Terms of Service</h1>
        <p className="legal-effective">Effective {EFFECTIVE_DATE}</p>

        <p>By creating an account or using Matrix Chat, you agree to these terms.</p>

        <h2>The service</h2>
        <p>
          Matrix Chat is an end-to-end encrypted messaging app (text, voice notes, files, and voice/video calls). See
          our <Link href="/privacy">Privacy Policy</Link> for exactly what data is collected and what is never
          readable by us.
        </p>

        <h2>Your account</h2>
        <ul>
          <li>You&apos;re responsible for the security of your password and for all activity on your account.</li>
          <li>You must provide a working email address to register — it&apos;s used only for account verification and password recovery.</li>
          <li>You may delete your account at any time from inside the app; this is permanent and cannot be undone.</li>
        </ul>

        <h2>Acceptable use</h2>
        <p>You agree not to use Matrix Chat to:</p>
        <ul>
          <li>Send content that is illegal, threatening, harassing, or infringes someone else&apos;s rights.</li>
          <li>Attempt to disrupt, overload, or gain unauthorized access to the service.</li>
          <li>Impersonate another person, or misrepresent your affiliation with any person or entity.</li>
        </ul>
        <p>
          Because messages are end-to-end encrypted, we cannot see message content and generally cannot moderate it.
          We may suspend or delete an account that we determine, from available metadata or a credible report,
          violates these terms.
        </p>

        <h2>No warranty</h2>
        <p>
          Matrix Chat is provided "as is," without warranty of any kind. End-to-end encryption protects message
          content in transit and at rest on our servers, but cannot protect against a compromised device, a lost
          password, or a person you&apos;re messaging sharing what you sent them. We do not guarantee the service
          will be uninterrupted, error-free, or available at all times.
        </p>

        <h2>Limitation of liability</h2>
        <p>
          To the fullest extent permitted by law, Matrix Chat and its operator are not liable for any indirect,
          incidental, or consequential damages arising from your use of the service.
        </p>

        <h2>Changes</h2>
        <p>
          We may update these terms or the app itself over time. If this document changes, the "Effective" date
          above will be updated. Continued use after a change means you accept the updated terms.
        </p>

        <h2>Contact</h2>
        <p>
          Questions about these terms: <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
        </p>
      </div>
    </div>
  );
}
