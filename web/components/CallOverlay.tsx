import { useCallback, useEffect, useRef, useState } from "react";
import { Avatar, avatarColorFor } from "./Avatar";
import { CallReaction, CallReactionsLayer, CallReactionTray } from "./CallReactions";

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
  video: boolean;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  // My camera is on / the peer's camera is on.
  cameraOn: boolean;
  peerCameraOn: boolean;
  // False when this device has no camera to send (or it's a voice call).
  canSendVideo: boolean;
  facing: "user" | "environment";
  reactions: CallReaction[];
  // The media path dropped and is being re-established.
  reconnecting: boolean;
  // The link is poor right now.
  weakConnection: boolean;
  // Connected per ICE/DTLS, but no inbound audio has actually arrived --
  // usually a TURN relay that accepted the connection but can't forward
  // media. Otherwise indistinguishable from a normal silent moment.
  noAudio: boolean;
  // Video was paused automatically to protect the audio (mine / the other person's).
  myVideoPaused: boolean;
  peerVideoPaused: boolean;
  onToggleCamera: () => void;
  onSwitchCamera: () => void;
  onReact: (emoji: string) => void;
  onAccept: () => void;
  onDecline: () => void;
  onToggleMute: () => void;
  onToggleSpeaker: () => void;
  onMinimize: () => void;
  onRestore: () => void;
  onUnlockAudio: () => void;
}

function MicIcon({ off, size = 28 }: { off: boolean; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
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

function CameraIcon({ off, size = 28 }: { off: boolean; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="6.5" width="12.5" height="11" rx="2.5" />
      <path d="M15.5 10.5l5-3v9l-5-3" />
      {off && <path d="M4 4l16 16" strokeWidth="2.2" />}
    </svg>
  );
}

function FlipIcon() {
  return (
    <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 8.5V7a2 2 0 0 1 2-2h2.2l1.2-1.6h5.2L15.8 5H18a2 2 0 0 1 2 2v1.5" />
      <path d="M20 15.5V17a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-1.5" />
      <path d="M8.5 11.5a3.5 3.5 0 0 1 6.2-2.2M15.5 12.5a3.5 3.5 0 0 1-6.2 2.2" />
      <path d="M15.2 7.6v1.9h-1.9M8.8 16.4v-1.9h1.9" />
    </svg>
  );
}

function ReactIcon() {
  return (
    <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M8.5 14.2a4 4 0 0 0 7 0" />
      <circle cx="9.3" cy="9.8" r="0.6" fill="currentColor" />
      <circle cx="14.7" cy="9.8" r="0.6" fill="currentColor" />
    </svg>
  );
}

const HANDSET_END =
  "M12 9c-2.5 0-4.9.5-7.1 1.5a1.7 1.7 0 0 0-.9 1.9l.5 2a1.7 1.7 0 0 0 1.4 1.3c1-.1 2-.3 2.9-.7.4-.2.7-.5.8-1l.3-1.2c1.4-.4 3-.4 4.4 0l.3 1.2c.1.5.4.8.8 1 .9.4 1.9.6 2.9.7a1.7 1.7 0 0 0 1.4-1.3l.5-2a1.7 1.7 0 0 0-.9-1.9C16.9 9.5 14.5 9 12 9z";
const HANDSET_ACCEPT =
  "M6.6 10.8c1.4 2.8 3.7 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1.1-.2 1.2.4 2.5.6 3.8.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C10.6 21 3 13.4 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.6.6 3.8.1.4 0 .8-.2 1.1L6.6 10.8z";

// Binds a MediaStream to a <video>. Remote video is always muted here -- its
// audio plays through the page's separate <audio> element -- and local video
// is muted so our own mic never echoes back through the speaker.
function StreamVideo({ stream, className, testId }: { stream: MediaStream; className: string; testId?: string }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.srcObject = stream;
    el.play().catch(() => {});
  }, [stream]);
  return <video ref={ref} className={className} data-testid={testId} autoPlay playsInline muted />;
}

const CONTROLS_HIDE_MS = 4500;

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
  video,
  localStream,
  remoteStream,
  cameraOn,
  peerCameraOn,
  canSendVideo,
  facing,
  reactions,
  reconnecting,
  weakConnection,
  noAudio,
  myVideoPaused,
  peerVideoPaused,
  onToggleCamera,
  onSwitchCamera,
  onReact,
  onAccept,
  onDecline,
  onToggleMute,
  onToggleSpeaker,
  onMinimize,
  onRestore,
  onUnlockAudio,
}: CallOverlayProps) {
  const incomingRinging = status === "incoming" && !connecting;
  const live = status === "connected" && !connecting;
  const [trayOpen, setTrayOpen] = useState(false);
  // Video calls hide the controls after a few idle seconds so the picture
  // gets the whole screen; a tap brings them back.
  const [uiVisible, setUiVisible] = useState(true);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const armHideTimer = useCallback(() => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = null;
    // Never hide the controls while reconnecting: hanging up must stay one tap away.
    if (video && live && !trayOpen && !reconnecting) {
      hideTimerRef.current = setTimeout(() => setUiVisible(false), CONTROLS_HIDE_MS);
    }
  }, [video, live, trayOpen, reconnecting]);

  useEffect(() => {
    setUiVisible(true);
    armHideTimer();
    return () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
  }, [armHideTimer]);

  // getUserMedia sits on the browser's / Android's permission prompt until it's
  // answered, during which there's no picture and nothing rings. Say so (after
  // a beat, so a quick grant doesn't flash it) instead of a silent "Calling…".
  const mediaPending = !localStream && !error && (status === "outgoing" || connecting);
  const [showPermissionHint, setShowPermissionHint] = useState(false);
  useEffect(() => {
    if (!mediaPending) {
      setShowPermissionHint(false);
      return;
    }
    const t = setTimeout(() => setShowPermissionHint(true), 1200);
    return () => clearTimeout(t);
  }, [mediaPending]);

  // The tray means nothing once the call isn't live.
  useEffect(() => {
    if (!live) setTrayOpen(false);
  }, [live]);

  function handleStageTap() {
    if (trayOpen) {
      setTrayOpen(false);
      return;
    }
    if (!video || !live) return;
    if (uiVisible) {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      setUiVisible(false);
    } else {
      setUiVisible(true);
      armHideTimer();
    }
  }

  let statusLine: string;
  if (error) statusLine = error;
  else if (mediaPending && showPermissionHint) statusLine = video ? "Waiting for camera permission…" : "Waiting for microphone permission…";
  else if (incomingRinging) statusLine = video ? "Matrix Chat video call" : "Matrix Chat voice call";
  else if (live && reconnecting) statusLine = "Reconnecting…";
  else if (live) statusLine = formatClock(duration);
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

  const permissionNote =
    mediaPending && showPermissionHint ? (
      <div className="call-permission-note" role="status">
        Choose <strong>Allow</strong> when asked to use your {video ? "camera and microphone" : "microphone"}.
      </div>
    ) : null;

  // Shown over the call while the connection is down or poor, so a freeze or a
  // dropout is explained instead of just happening.
  const netBanner =
    live && !error && (reconnecting || weakConnection || noAudio) ? (
      <div className={`call-net-banner ${reconnecting ? "reconnecting" : ""}`} role="status" data-testid="call-net-banner">
        <span className="call-net-dot" aria-hidden="true" />
        {reconnecting
          ? "Reconnecting… waiting for your connection"
          : noAudio
            ? "No audio is coming through — try switching Wi-Fi/mobile data, or reconnect the call"
            : myVideoPaused
              ? "Weak connection — video paused to keep the call clear"
              : "Weak connection"}
      </div>
    ) : null;

  const bgTint = (
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
  );

  // ---------------------------------------------------------------- video ---
  // Once the call is under way (or answered and connecting) the peer fills the
  // screen with me in a small corner tile. While it's still ringing, my own
  // camera fills the screen instead -- what WhatsApp and Meet both do.
  if (video && !incomingRinging) {
    const answered = status === "connected" || connecting;
    const showPeerVideo = answered && peerCameraOn && !!remoteStream;
    const selfFull = !answered;
    const mirror = facing === "user";
    const chromeHidden = !uiVisible && live && !error && !reconnecting;

    return (
      <div className={`call-screen call-video ${chromeHidden ? "chrome-hidden" : ""} ${reconnecting && live ? "is-reconnecting" : ""}`} role="dialog" aria-label="Video call">
        <div className="call-card">
          {bgTint}

          <div className="call-stage" onClick={handleStageTap} data-testid="call-stage">
            {showPeerVideo && <StreamVideo stream={remoteStream!} className="call-remote-video" testId="call-remote-video" />}

            {!showPeerVideo && !selfFull && (
              <div className="call-peer-placeholder">
                <div className={`call-avatar-wrap ${waiting && !error ? "call-pulse" : ""}`}>
                  <Avatar name={peerUsername} avatarUrl={peerAvatarUrl} size={132} />
                </div>
                {live && (
                  <div className="call-camera-off-note">
                    {peerVideoPaused ? `${peerUsername}'s video is paused (weak connection)` : `${peerUsername}'s camera is off`}
                  </div>
                )}
              </div>
            )}

            {selfFull && localStream && cameraOn && (
              <StreamVideo stream={localStream} className={`call-self-full ${mirror ? "mirror" : ""}`} testId="call-self-video" />
            )}
            {selfFull && (!localStream || !cameraOn) && (
              <div className="call-peer-placeholder">
                <div className="call-avatar-wrap call-pulse">
                  <Avatar name={peerUsername} avatarUrl={peerAvatarUrl} size={132} />
                </div>
                {permissionNote}
              </div>
            )}
            {selfFull && <div className="call-stage-shade" aria-hidden="true" />}
          </div>

          <div className="call-topbar call-topbar-video">
            <button type="button" className="call-topbar-btn" onClick={onMinimize} aria-label="Minimize call">
              <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M6 9l6 6 6-6" />
              </svg>
            </button>
            <div className="call-video-title">
              <div className="call-name">{peerUsername}</div>
              <div className="call-status" data-testid="call-status">
                {statusLine}
              </div>
            </div>
            {answered && canSendVideo && cameraOn ? (
              <button type="button" className="call-topbar-btn" onClick={onSwitchCamera} aria-label="Switch camera">
                <FlipIcon />
              </button>
            ) : (
              <span className="call-topbar-btn" />
            )}
          </div>

          {netBanner}

          {peerMuted && live && (
            <div className="call-peer-muted-chip" aria-label={`${peerUsername} is muted`}>
              <MicIcon off size={16} />
              {peerUsername}
            </div>
          )}

          {answered && canSendVideo && (
            <div className={`call-self-pip ${mirror && cameraOn ? "mirror" : ""} ${chromeHidden ? "low" : ""} ${trayOpen ? "raised" : ""}`} data-testid="call-self-pip">
              {cameraOn && localStream ? (
                <StreamVideo stream={localStream} className="call-self-pip-video" testId="call-self-video" />
              ) : (
                <div className="call-self-off">
                  <CameraIcon off size={26} />
                  <span>Camera off</span>
                </div>
              )}
              {myVideoPaused && cameraOn && <span className="call-self-paused">Video paused</span>}
              <span className="call-self-pip-label">You</span>
            </div>
          )}

          {needsAudioUnlock && !error && (
            <button type="button" className="call-audio-unlock call-audio-unlock-video" onClick={onUnlockAudio}>
              🔊 Tap to hear audio
            </button>
          )}

          <CallReactionsLayer reactions={reactions} />

          {trayOpen && live && <CallReactionTray onReact={onReact} />}

          <div className="call-controls call-controls-video" onPointerDown={armHideTimer}>
            {canSendVideo && (
              <button
                type="button"
                className={`call-ctl-btn ${cameraOn ? "" : "on"}`}
                onClick={onToggleCamera}
                aria-label={cameraOn ? "Turn camera off" : "Turn camera on"}
                aria-pressed={!cameraOn}
              >
                <CameraIcon off={!cameraOn} />
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
            {live && (
              <button
                type="button"
                className={`call-ctl-btn ${trayOpen ? "active" : ""}`}
                onClick={() => setTrayOpen((v) => !v)}
                aria-label="Reactions"
                aria-expanded={trayOpen}
              >
                <ReactIcon />
              </button>
            )}
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
            <button type="button" className="call-ctl-btn call-ctl-end" onClick={onDecline} aria-label="End call">
              <svg viewBox="0 0 24 24" width="30" height="30" fill="currentColor">
                <path d={HANDSET_END} />
              </svg>
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------- voice ---
  return (
    <div className="call-screen" role="dialog" aria-label={video ? "Video call" : "Voice call"}>
      <div className="call-card">
        {bgTint}

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

        {netBanner}

        <div className="call-main" onClick={() => trayOpen && setTrayOpen(false)}>
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
          {permissionNote}
        </div>

        <CallReactionsLayer reactions={reactions} />

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
                {video ? (
                  <CameraIcon off={false} size={30} />
                ) : (
                  <svg viewBox="0 0 24 24" width="30" height="30" fill="currentColor">
                    <path d={HANDSET_ACCEPT} />
                  </svg>
                )}
              </button>
              <span className="call-ctl-label">Accept</span>
            </div>
          </div>
        ) : (
          <>
            {trayOpen && live && <CallReactionTray onReact={onReact} />}
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
              {live && (
                <button
                  type="button"
                  className={`call-ctl-btn ${trayOpen ? "active" : ""}`}
                  onClick={() => setTrayOpen((v) => !v)}
                  aria-label="Reactions"
                  aria-expanded={trayOpen}
                >
                  <ReactIcon />
                </button>
              )}
              <button type="button" className="call-ctl-btn call-ctl-end" onClick={onDecline} aria-label="End call">
                <svg viewBox="0 0 24 24" width="30" height="30" fill="currentColor">
                  <path d={HANDSET_END} />
                </svg>
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
