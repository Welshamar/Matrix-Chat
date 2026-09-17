import { useEffect, useRef, useState } from "react";

const MAX_RECORDING_SECONDS = 120;
const LOCK_DRAG_PX = 60; // drag up past this while held = lock (hands-free)
const CANCEL_DRAG_PX = 80; // drag left past this then release = cancel
const PREFERRED_MIME_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];

function pickMimeType(): string | undefined {
  return PREFERRED_MIME_TYPES.find((t) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t));
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read recorded audio."));
    reader.onload = () => resolve(reader.result as string);
    reader.readAsDataURL(blob);
  });
}

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

type RecordState = "idle" | "holding" | "locked";

interface VoiceRecorderButtonProps {
  onRecorded: (dataUrl: string) => void;
  disabled?: boolean;
  /** Lets the composer hide the text input/emoji/attach row while recording,
   *  so the recording bar can take over the full composer pill like WhatsApp. */
  onRecordingChange?: (recording: boolean) => void;
}

export function VoiceRecorderButton({ onRecorded, disabled, onRecordingChange }: VoiceRecorderButtonProps) {
  const [state, setState] = useState<RecordState>("idle");
  const [paused, setPaused] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [dragX, setDragX] = useState(0);
  const [dragY, setDragY] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const stateRef = useRef<RecordState>("idle");
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const outcomeRef = useRef<"send" | "cancel">("send");
  const dragOriginRef = useRef<{ x: number; y: number } | null>(null);
  const pointerIdRef = useRef<number | null>(null);
  const latestDragXRef = useRef(0);
  const pausedRef = useRef(false);

  useEffect(() => {
    stateRef.current = state;
    onRecordingChange?.(state !== "idle");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  // Tracked at the window level rather than on the button itself — the
  // button that received pointerdown gets unmounted the moment state
  // flips to "holding" (swapped out for the recording bar), which would
  // silently kill a per-element pointer capture mid-drag.
  useEffect(() => {
    if (state !== "holding") return;

    function onMove(e: PointerEvent) {
      if (e.pointerId !== pointerIdRef.current || !dragOriginRef.current) return;
      const dx = Math.min(0, e.clientX - dragOriginRef.current.x);
      const dy = Math.min(0, e.clientY - dragOriginRef.current.y);
      latestDragXRef.current = dx;
      setDragX(dx);
      setDragY(dy);

      if (-dy >= LOCK_DRAG_PX) {
        setDragX(0);
        setDragY(0);
        setState("locked");
      }
    }

    function onUp(e: PointerEvent) {
      if (e.pointerId !== pointerIdRef.current) return;
      pointerIdRef.current = null;
      if (stateRef.current !== "holding") return;
      const cancelled = -latestDragXRef.current >= CANCEL_DRAG_PX;
      setDragX(0);
      setDragY(0);
      finishRecording(cancelled ? "cancel" : "send");
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  function cleanup() {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    recorderRef.current = null;
    pausedRef.current = false;
    setElapsed(0);
    setPaused(false);
    setDragX(0);
    setDragY(0);
  }

  async function startRecording(e: React.PointerEvent) {
    if (disabled || stateRef.current !== "idle") return;
    setError(null);
    outcomeRef.current = "send";
    pointerIdRef.current = e.pointerId;
    dragOriginRef.current = { x: e.clientX, y: e.clientY };

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];

      const mimeType = pickMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorderRef.current = recorder;

      recorder.ondataavailable = (ev) => {
        if (ev.data.size > 0) chunksRef.current.push(ev.data);
      };
      recorder.onstop = async () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
        const shouldSend = outcomeRef.current === "send";
        cleanup();
        setState("idle");
        if (shouldSend && blob.size > 0) {
          const dataUrl = await blobToDataUrl(blob);
          onRecorded(dataUrl);
        }
      };

      recorder.start();
      setState("holding");

      let seconds = 0;
      timerRef.current = setInterval(() => {
        if (pausedRef.current) return;
        seconds += 1;
        setElapsed(seconds);
        if (seconds >= MAX_RECORDING_SECONDS) finishRecording("send");
      }, 1000);
    } catch {
      setError("Microphone access denied or unavailable.");
      cleanup();
      setState("idle");
    }
  }

  function finishRecording(outcome: "send" | "cancel") {
    outcomeRef.current = outcome;
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      recorderRef.current.stop();
    } else {
      cleanup();
      setState("idle");
    }
  }

  function togglePause() {
    const recorder = recorderRef.current;
    if (!recorder) return;
    if (recorder.state === "recording") {
      recorder.pause();
      pausedRef.current = true;
      setPaused(true);
    } else if (recorder.state === "paused") {
      recorder.resume();
      pausedRef.current = false;
      setPaused(false);
    }
  }

  if (state === "holding" || state === "locked") {
    const dragging = state === "holding";
    return (
      <div className="voice-recording-bar">
        {state === "locked" ? (
          <button type="button" className="voice-locked-trash" onClick={() => finishRecording("cancel")} aria-label="Cancel recording">
            🗑
          </button>
        ) : (
          <span className="voice-recording-dot" />
        )}
        <span className="voice-recording-time">{formatElapsed(elapsed)}</span>
        <span className={`voice-recording-wave ${paused ? "voice-recording-wave-paused" : ""}`}>
          {Array.from({ length: 18 }).map((_, i) => (
            <span key={i} className="voice-recording-wave-bar" style={{ animationDelay: `${i * 0.07}s` }} />
          ))}
        </span>
        {dragging && <span className="voice-slide-hint">◀ Slide to cancel</span>}
        {state === "locked" && (
          <>
            <button
              type="button"
              className="voice-locked-pause"
              onClick={togglePause}
              aria-label={paused ? "Resume recording" : "Pause recording"}
            >
              {paused ? "▶" : "⏸"}
            </button>
            <button type="button" className="voice-locked-send" onClick={() => finishRecording("send")} aria-label="Send voice message">
              ➤
            </button>
          </>
        )}
        {dragging && (
          <div className="voice-mic-btn voice-mic-btn-dragging" style={{ transform: `translate(${dragX}px, ${dragY}px)` }}>
            <MicIcon />
          </div>
        )}
      </div>
    );
  }

  return (
    <>
      <button
        type="button"
        className="voice-mic-btn"
        onPointerDown={startRecording}
        disabled={disabled}
        aria-label="Hold to record a voice message"
        title="Hold to record"
      >
        <MicIcon />
      </button>
      {error && <div className="inline-error">{error}</div>}
    </>
  );
}

function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="9" y="2.5" width="6" height="12" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0" strokeLinecap="round" />
      <path d="M12 17.5v3" strokeLinecap="round" />
      <path d="M8.5 20.5h7" strokeLinecap="round" />
    </svg>
  );
}
