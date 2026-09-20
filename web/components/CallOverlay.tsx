import { Avatar, avatarColorFor } from "./Avatar";

export type CallStatus = "outgoing" | "incoming" | "connected";

// WhatsApp shows the running time as 00:12, zero-padded.
function formatClock(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

interface CallOverlayProps {
  status: CallStatus;
  peerUsername: string;
  peerAvatarUrl?: string | null;
  duration: number;
  muted: boolean;
  // The other person has muted their mic.
  peerMuted: boolean;
  speakerOn: boolean;
  // The earpiece/speaker route only exists on the native Android shell.
  showSpeaker: boolean;
  // Outgoing: the other phone is ringing (as opposed to still dialling).
  ringing: boolean;
  // Answered, but the audio connection isn't up yet.
  connecting: boolean;
  minimized: boolean;
  error: string | null;
  needsAudioUnlock: boolean;
  onAccept: () => void;
  onDecline: () => void;
  onToggleMute: () => void;
  onToggleSpeaker: () => void;
  onMinimize: () => void;
  onRestore: () => void;
  onUnlockAudio: () => void;
}

function MicIcon({ off }: { off: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7" />
      {off && <path d="M4 4l16 16" strokeWidth="2.2" />}
    </svg>
  );
}

function SpeakerIcon() {
  return (
    <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5H4z" fill="currentColor" />
      <path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" />
    </svg>
  );
}

const HANDSET_END =
  "M12 9c-2.5 0-4.9.5-7.1 1.5a1.7 1.7 0 0 0-.9 1.9l.5 2a1.7 1.7 0 0 0 1.4 1.3c1-.1 2-.3 2.9-.7.4-.2.7-.5.8-1l.3-1.2c1.4-.4 3-.4 4.4 0l.3 1.2c.1.5.4.8.8 1 .9.4 1.9.6 2.9.7a1.7 1.7 0 0 0 1.4-1.3l.5-2a1.7 1.7 0 0 0-.9-1.9C16.9 9.5 14.5 9 12 9z";
const HANDSET_ACCEPT =
  "M6.6 10.8c1.4 2.8 3.7 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1.1-.2 1.2.4 2.5.6 3.8.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C10.6 21 3 13.4 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.6.6 3.8.1.4 0 .8-.2 1.1L6.6 10.8z";

export function CallOverlay({
  status,
  peerUsername,
  peerAvatarUrl,
  duration,
  muted,
  peerMuted,
  speakerOn,
  showSpeaker,
  ringing,
  connecting,
  minimized,
  error,
  needsAudioUnlock,
  onAccept,
  onDecline,
  onToggleMute,
  onToggleSpeaker,
  onMinimize,
  onRestore,
  onUnlockAudio,
}: CallOverlayProps) {
  const incomingRinging = status === "incoming" && !connecting;

  let statusLine: string;
  if (error) statusLine = error;
  else if (incomingRinging) statusLine = "Matrix Chat voice call";
  else if (status === "connected" && !connecting) statusLine = formatClock(duration);
  else if (connecting || status === "incoming") statusLine = "Connecting…";
  else statusLine = ringing ? "Ringing…" : "Calling…";

  // The pulse rings mean "still waiting for the other person / the audio".
  const waiting = status !== "connected" || connecting;

  // Minimized to a "tap to return" bar under the status bar, like WhatsApp.
  if (minimized && !incomingRinging) {
    return (
      <button type="button" className="call-mini-bar" onClick={onRestore} aria-label="Return to call">
        <span className="call-mini-text">Tap to return to call</span>
        <span className="call-mini-meta">
          {muted && (
            <span className="call-mini-icon">
              <MicIcon off />
            </span>
          )}
          {statusLine}
        </span>
      </button>
    );
  }

  return (
    <div className="call-screen" role="dialog" aria-label="Voice call">
      <div className="call-card">
        <div className="call-bg" aria-hidden="true">
          {peerAvatarUrl && <div className="call-bg-photo" style={{ backgroundImage: `url(${peerAvatarUrl})` }} />}
          <div
            className="call-bg-tint"
            style={{
              background: `radial-gradient(130% 70% at 50% 0%, ${avatarColorFor(peerUsername)}66 0%, transparent 62%), linear-gradient(180deg, #101a20 0%, #0a1014 100%)`,
              opacity: peerAvatarUrl ? 0.72 : 1,
            }}
          />
        </div>

        <div className="call-topbar">
          {!incomingRinging ? (
            <button type="button" className="call-topbar-btn" onClick={onMinimize} aria-label="Minimize call">
              <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M6 9l6 6 6-6" />
              </svg>
            </button>
          ) : (
            <span className="call-topbar-btn" />
          )}
          <div className="call-e2e">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true">
              <path d="M17 9h-1V7a4 4 0 0 0-8 0v2H7a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2zm-7-2a2 2 0 0 1 4 0v2h-4V7z" />
            </svg>
            End-to-end encrypted
          </div>
          <span className="call-topbar-btn" />
        </div>

        <div className="call-main">
          <div className="call-name">{peerUsername}</div>
          <div className="call-status" data-testid="call-status">
            {statusLine}
          </div>

          {needsAudioUnlock && !error && (
            <button type="button" className="call-audio-unlock" onClick={onUnlockAudio}>
              🔊 Tap to hear audio
            </button>
          )}

          <div className={`call-avatar-wrap ${waiting && !error ? "call-pulse" : ""}`}>
            <Avatar name={peerUsername} avatarUrl={peerAvatarUrl} size={168} />
            {peerMuted && status === "connected" && (
              <span className="call-avatar-muted" aria-label={`${peerUsername} is muted`} title="Muted">
                <MicIcon off />
              </span>
            )}
          </div>
          {peerMuted && status === "connected" && <div className="call-peer-muted-note">{peerUsername} muted their mic</div>}
        </div>

        {incomingRinging ? (
          <div className="call-controls call-controls-incoming">
            <div className="call-answer-col">
              <button type="button" className="call-ctl-btn call-ctl-end" onClick={onDecline} aria-label="Decline call">
                <svg viewBox="0 0 24 24" width="30" height="30" fill="currentColor">
                  <path d={HANDSET_END} />
                </svg>
              </button>
              <span className="call-ctl-label">Decline</span>
            </div>
            <div className="call-answer-col">
              <button type="button" className="call-ctl-btn call-ctl-accept" onClick={onAccept} aria-label="Accept call">
                <svg viewBox="0 0 24 24" width="30" height="30" fill="currentColor">
                  <path d={HANDSET_ACCEPT} />
                </svg>
              </button>
              <span className="call-ctl-label">Accept</span>
            </div>
          </div>
        ) : (
          <div className="call-controls">
            {showSpeaker && (
              <button
                type="button"
                className={`call-ctl-btn ${speakerOn ? "on" : ""}`}
                onClick={onToggleSpeaker}
                aria-label={speakerOn ? "Turn speaker off" : "Turn speaker on"}
                aria-pressed={speakerOn}
              >
                <SpeakerIcon />
              </button>
            )}
            <button
              type="button"
              className={`call-ctl-btn ${muted ? "on" : ""}`}
              onClick={onToggleMute}
              aria-label={muted ? "Unmute" : "Mute"}
              aria-pressed={muted}
            >
              <MicIcon off={muted} />
            </button>
            <button type="button" className="call-ctl-btn call-ctl-end" onClick={onDecline} aria-label="End call">
              <svg viewBox="0 0 24 24" width="30" height="30" fill="currentColor">
                <path d={HANDSET_END} />
              </svg>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
