import { Avatar } from "./Avatar";

export type CallStatus = "outgoing" | "incoming" | "connected";

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

interface CallOverlayProps {
  status: CallStatus;
  peerUsername: string;
  peerAvatarUrl?: string | null;
  duration: number;
  muted: boolean;
  error: string | null;
  onAccept: () => void;
  onDecline: () => void;
  onToggleMute: () => void;
}

export function CallOverlay({
  status,
  peerUsername,
  peerAvatarUrl,
  duration,
  muted,
  error,
  onAccept,
  onDecline,
  onToggleMute,
}: CallOverlayProps) {
  const statusLine =
    status === "outgoing" ? "Calling..." : status === "incoming" ? "Incoming voice call" : formatDuration(duration);

  return (
    <>
      <div className="modal-backdrop" />
      <div className="modal call-overlay">
        <div className={`call-overlay-avatar-wrap ${status !== "connected" ? "call-pulse" : ""}`}>
          <Avatar name={peerUsername} avatarUrl={peerAvatarUrl} size={88} />
        </div>
        <div className="call-overlay-name">{peerUsername}</div>
        <div className="call-overlay-status">{error ?? statusLine}</div>

        <div className="call-overlay-actions">
          {status === "incoming" ? (
            <>
              <button type="button" className="call-btn call-btn-reject" onClick={onDecline} aria-label="Decline call">
                <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor">
                  <path d="M12 9c-2.5 0-4.9.5-7.1 1.5a1.7 1.7 0 0 0-.9 1.9l.5 2a1.7 1.7 0 0 0 1.4 1.3c1-.1 2-.3 2.9-.7.4-.2.7-.5.8-1l.3-1.2c1.4-.4 3-.4 4.4 0l.3 1.2c.1.5.4.8.8 1 .9.4 1.9.6 2.9.7a1.7 1.7 0 0 0 1.4-1.3l.5-2a1.7 1.7 0 0 0-.9-1.9C16.9 9.5 14.5 9 12 9z" />
                </svg>
              </button>
              <button type="button" className="call-btn call-btn-accept" onClick={onAccept} aria-label="Accept call">
                <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor">
                  <path d="M6.6 10.8c1.4 2.8 3.7 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1.1-.2 1.2.4 2.5.6 3.8.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C10.6 21 3 13.4 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.6.6 3.8.1.4 0 .8-.2 1.1L6.6 10.8z" />
                </svg>
              </button>
            </>
          ) : status === "outgoing" ? (
            <button type="button" className="call-btn call-btn-reject" onClick={onDecline} aria-label="Cancel call">
              <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor">
                <path d="M12 9c-2.5 0-4.9.5-7.1 1.5a1.7 1.7 0 0 0-.9 1.9l.5 2a1.7 1.7 0 0 0 1.4 1.3c1-.1 2-.3 2.9-.7.4-.2.7-.5.8-1l.3-1.2c1.4-.4 3-.4 4.4 0l.3 1.2c.1.5.4.8.8 1 .9.4 1.9.6 2.9.7a1.7 1.7 0 0 0 1.4-1.3l.5-2a1.7 1.7 0 0 0-.9-1.9C16.9 9.5 14.5 9 12 9z" />
              </svg>
            </button>
          ) : (
            <>
              <button
                type="button"
                className={`call-btn call-btn-mute ${muted ? "armed" : ""}`}
                onClick={onToggleMute}
                aria-label={muted ? "Unmute" : "Mute"}
              >
                {muted ? "🔇" : "🎙"}
              </button>
              <button type="button" className="call-btn call-btn-reject" onClick={onDecline} aria-label="End call">
                <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor">
                  <path d="M12 9c-2.5 0-4.9.5-7.1 1.5a1.7 1.7 0 0 0-.9 1.9l.5 2a1.7 1.7 0 0 0 1.4 1.3c1-.1 2-.3 2.9-.7.4-.2.7-.5.8-1l.3-1.2c1.4-.4 3-.4 4.4 0l.3 1.2c.1.5.4.8.8 1 .9.4 1.9.6 2.9.7a1.7 1.7 0 0 0 1.4-1.3l.5-2a1.7 1.7 0 0 0-.9-1.9C16.9 9.5 14.5 9 12 9z" />
                </svg>
              </button>
            </>
          )}
        </div>
      </div>
    </>
  );
}
