import { useRef, useState } from "react";

const MAX_RECORDING_SECONDS = 120;
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

interface VoiceRecorderButtonProps {
  onRecorded: (dataUrl: string) => void;
  disabled?: boolean;
}

export function VoiceRecorderButton({ onRecorded, disabled }: VoiceRecorderButtonProps) {
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function cleanup() {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    recorderRef.current = null;
    setElapsed(0);
  }

  async function startRecording() {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];

      const mimeType = pickMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorderRef.current = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = async () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
        cleanup();
        if (blob.size > 0) {
          const dataUrl = await blobToDataUrl(blob);
          onRecorded(dataUrl);
        }
      };

      recorder.start();
      setRecording(true);

      let seconds = 0;
      timerRef.current = setInterval(() => {
        seconds += 1;
        setElapsed(seconds);
        if (seconds >= MAX_RECORDING_SECONDS) stopRecording();
      }, 1000);
    } catch {
      setError("Microphone access denied or unavailable.");
      cleanup();
      setRecording(false);
    }
  }

  function stopRecording() {
    recorderRef.current?.stop();
    setRecording(false);
  }

  function handleCancel() {
    if (recorderRef.current) {
      recorderRef.current.onstop = null;
      recorderRef.current.stop();
    }
    cleanup();
    setRecording(false);
  }

  if (recording) {
    return (
      <div className="voice-recording-indicator">
        <span className="voice-recording-dot" />
        <span className="voice-recording-time">{formatElapsed(elapsed)}</span>
        <button type="button" className="composer-icon-btn" onClick={handleCancel} aria-label="Cancel recording">
          🗑
        </button>
        <button type="button" className="composer-send-btn" onClick={stopRecording} aria-label="Send voice message">
          ➤
        </button>
      </div>
    );
  }

  return (
    <>
      <button
        type="button"
        className="composer-icon-btn"
        onClick={startRecording}
        disabled={disabled}
        aria-label="Record voice message"
        title="Record voice message"
      >
        🎤
      </button>
      {error && <div className="inline-error">{error}</div>}
    </>
  );
}
