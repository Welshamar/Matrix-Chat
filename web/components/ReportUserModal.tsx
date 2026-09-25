import { useState } from "react";

interface ReportUserModalProps {
  username: string;
  onSubmit: (reason: string) => Promise<void>;
  onClose: () => void;
}

const MAX_REASON_LENGTH = 1000;

export function ReportUserModal({ username, onSubmit, onClose }: ReportUserModalProps) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  async function handleSubmit() {
    if (!reason.trim()) {
      setError("Tell us what's wrong so we can look into it.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(reason.trim());
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send report.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <div className="modal-backdrop" onClick={onClose} />
      <div className="modal">
        {done ? (
          <>
            <h2 className="modal-title">Report sent</h2>
            <p>Thanks — we'll review your report about {username}.</p>
            <div className="modal-actions">
              <button className="btn-primary" type="button" onClick={onClose}>
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            <h2 className="modal-title">Report {username}</h2>
            <div className="field">
              <label>What's going on?</label>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={MAX_REASON_LENGTH}
                rows={4}
                placeholder="Describe what happened..."
                autoFocus
              />
            </div>
            {error && <div className="error-banner">{error}</div>}
            <div className="modal-actions">
              <button className="btn-secondary" type="button" onClick={onClose} disabled={submitting}>
                Cancel
              </button>
              <button className="btn-primary" type="button" onClick={handleSubmit} disabled={submitting}>
                {submitting ? "Sending..." : "Submit report"}
              </button>
            </div>
          </>
        )}
      </div>
    </>
  );
}
