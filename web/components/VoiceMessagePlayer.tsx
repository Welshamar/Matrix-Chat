import { useEffect, useMemo, useRef, useState } from "react";
import { Avatar } from "./Avatar";

const BAR_COUNT = 32;

interface Decoded {
  peaks: number[];
  duration: number;
}

// Decoded once per message and remembered — a thread re-renders constantly,
// and decoding is by far the most expensive thing this component does.
const decodedCache = new Map<string, Decoded | null>();
const decodeInflight = new Map<string, Promise<Decoded | null>>();
// Decodes run one at a time: a long thread can mount many voice notes at once
// and each decode briefly holds the full PCM in memory.
let decodeChain: Promise<unknown> = Promise.resolve();

// Only one voice note plays at a time, like WhatsApp.
let activeAudio: HTMLAudioElement | null = null;

function decodeVoiceNote(key: string, src: string): Promise<Decoded | null> {
  if (decodedCache.has(key)) return Promise.resolve(decodedCache.get(key) ?? null);
  const running = decodeInflight.get(key);
  if (running) return running;

  const job = decodeChain.then(async (): Promise<Decoded | null> => {
    try {
      const bytes = await (await fetch(src)).arrayBuffer();
      // 8kHz is plenty for a waveform and keeps the transient PCM small; an
      // OfflineAudioContext also doesn't count against the browser's limit
      // on live AudioContexts.
      const ctx = new OfflineAudioContext(1, 1, 8000);
      const audio = await ctx.decodeAudioData(bytes);
      const samples = audio.getChannelData(0);
      const chunk = Math.max(1, Math.floor(samples.length / BAR_COUNT));
      const raw: number[] = [];
      for (let i = 0; i < BAR_COUNT; i++) {
        let sum = 0;
        const start = i * chunk;
        const end = Math.min(samples.length, start + chunk);
        for (let j = start; j < end; j++) sum += Math.abs(samples[j]);
        raw.push(end > start ? sum / (end - start) : 0);
      }
      const max = Math.max(...raw) || 1;
      const peaks = raw.map((v) => 0.16 + 0.84 * Math.pow(v / max, 0.7));
      return { peaks, duration: audio.duration };
    } catch {
      return null;
    }
  });
  decodeChain = job;

  const tracked = job.then((result) => {
    decodedCache.set(key, result);
    decodeInflight.delete(key);
    return result;
  });
  decodeInflight.set(key, tracked);
  return tracked;
}

// Stand-in bars (and the fallback if the audio can't be decoded), seeded from
// the message id so a given note always looks the same.
function seededBars(seed: string): number[] {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  const bars: number[] = [];
  for (let i = 0; i < BAR_COUNT; i++) {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    const r = ((h ^ (h >>> 16)) >>> 0) / 4294967296;
    bars.push(0.2 + 0.8 * r * (0.55 + 0.45 * Math.sin((i / BAR_COUNT) * Math.PI)));
  }
  return bars;
}

function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;
}

interface VoiceMessagePlayerProps {
  messageId: string;
  src: string;
  avatarName: string;
  avatarUrl?: string | null;
  direction: "in" | "out";
}

export function VoiceMessagePlayer({ messageId, src, avatarName, avatarUrl, direction }: VoiceMessagePlayerProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const waveRef = useRef<HTMLDivElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const draggingRef = useRef(false);

  const [visible, setVisible] = useState(false);
  const [decoded, setDecoded] = useState<Decoded | null>(decodedCache.get(messageId) ?? null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [nativeDuration, setNativeDuration] = useState(0);

  const fallbackBars = useMemo(() => seededBars(messageId), [messageId]);
  const bars = decoded?.peaks ?? fallbackBars;
  const duration = decoded?.duration || nativeDuration;
  const progress = duration > 0 ? Math.min(1, current / duration) : 0;

  // Decode lazily, only once the bubble actually scrolls into view.
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setVisible(true);
        observer.disconnect();
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible || decoded) return;
    let cancelled = false;
    decodeVoiceNote(messageId, src).then((result) => {
      if (!cancelled && result) setDecoded(result);
    });
    return () => {
      cancelled = true;
    };
  }, [visible, decoded, messageId, src]);

  // Smooth scrubber movement — the audio element's own timeupdate only fires
  // a few times a second.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      if (audioRef.current) setCurrent(audioRef.current.currentTime);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  useEffect(() => {
    const audio = audioRef.current;
    return () => {
      audio?.pause();
      if (activeAudio === audio) activeAudio = null;
    };
  }, []);

  // MediaRecorder output (webm) usually has no duration header, so the
  // element reports Infinity and can't seek. Seeking to a huge time makes the
  // browser work the real length out; then rewind.
  function handleLoadedMetadata() {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.duration === Infinity) {
      const rewind = () => {
        audio.removeEventListener("timeupdate", rewind);
        audio.currentTime = 0;
        if (Number.isFinite(audio.duration)) setNativeDuration(audio.duration);
      };
      audio.addEventListener("timeupdate", rewind);
      audio.currentTime = 1e101;
    } else if (Number.isFinite(audio.duration)) {
      setNativeDuration(audio.duration);
    }
  }

  async function togglePlay() {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      if (activeAudio && activeAudio !== audio) activeAudio.pause();
      activeAudio = audio;
      try {
        await audio.play();
      } catch {
        // Autoplay/permission refusal — the button just stays on "play".
      }
    } else {
      audio.pause();
    }
  }

  function seekTo(clientX: number) {
    const audio = audioRef.current;
    const wave = waveRef.current;
    if (!audio || !wave || !duration) return;
    const rect = wave.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    audio.currentTime = ratio * duration;
    setCurrent(audio.currentTime);
  }

  function handleWavePointerDown(e: React.PointerEvent) {
    // Keep the bubble's own swipe-to-reply gesture from grabbing this drag.
    e.stopPropagation();
    draggingRef.current = true;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    seekTo(e.clientX);
  }

  function handleWavePointerMove(e: React.PointerEvent) {
    if (!draggingRef.current) return;
    e.stopPropagation();
    seekTo(e.clientX);
  }

  function handleWavePointerEnd(e: React.PointerEvent) {
    if (!draggingRef.current) return;
    e.stopPropagation();
    draggingRef.current = false;
  }

  const started = playing || current > 0;

  return (
    <div className={`voice-msg voice-msg-${direction}`} ref={rootRef}>
      <div className="voice-msg-avatar">
        <Avatar name={avatarName} avatarUrl={avatarUrl} size={40} />
        <span className="voice-msg-mic" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="10" height="10" fill="currentColor">
            <path d="M12 14.5a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5.5a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5.5a6.5 6.5 0 0 0 5.75 6.45V21h1.5v-3.05A6.5 6.5 0 0 0 18.5 11.5H17z" />
          </svg>
        </span>
      </div>

      <button
        type="button"
        className="voice-msg-play"
        onClick={(e) => {
          e.stopPropagation();
          togglePlay();
        }}
        onPointerDown={(e) => e.stopPropagation()}
        aria-label={playing ? "Pause voice message" : "Play voice message"}
      >
        {playing ? (
          <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor">
            <rect x="6" y="5" width="4" height="14" rx="1" />
            <rect x="14" y="5" width="4" height="14" rx="1" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor">
            <path d="M8 5.2v13.6a1 1 0 0 0 1.5.86l11-6.8a1 1 0 0 0 0-1.72l-11-6.8A1 1 0 0 0 8 5.2z" />
          </svg>
        )}
      </button>

      <div className="voice-msg-body">
        <div
          className="voice-msg-wave"
          ref={waveRef}
          role="slider"
          aria-label="Voice message position"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(current)}
          onPointerDown={handleWavePointerDown}
          onPointerMove={handleWavePointerMove}
          onPointerUp={handleWavePointerEnd}
          onPointerCancel={handleWavePointerEnd}
        >
          {bars.map((h, i) => (
            <span
              key={i}
              className={`voice-msg-bar ${(i + 0.5) / BAR_COUNT <= progress ? "played" : ""}`}
              style={{ height: `${Math.round(h * 100)}%` }}
            />
          ))}
          <span className="voice-msg-dot" style={{ left: `${progress * 100}%` }} />
        </div>
        <span className="voice-msg-duration">{formatClock(started ? current : duration)}</span>
      </div>

      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        className="voice-msg-audio"
        onLoadedMetadata={handleLoadedMetadata}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setCurrent(0);
          if (audioRef.current) audioRef.current.currentTime = 0;
        }}
      />
    </div>
  );
}
