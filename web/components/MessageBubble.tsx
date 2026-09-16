import { useRef, useState } from "react";
import { LocalMessage } from "@/lib/localDb";

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileIconFor(mime: string): string {
  if (mime.startsWith("video/")) return "🎬";
  if (mime === "application/pdf") return "📕";
  if (mime.includes("zip") || mime.includes("compressed")) return "🗜";
  if (mime.startsWith("audio/")) return "🎵";
  if (mime.includes("word") || mime.includes("document")) return "📝";
  if (mime.includes("sheet") || mime.includes("excel")) return "📊";
  return "📄";
}

const EMOJI_ONLY_MAX_CHARS = 12;
const SWIPE_TRIGGER_PX = 56;
const SWIPE_MAX_PX = 72;

// True for a short message made up entirely of emoji (optionally combined
// with ZWJs/variation selectors) — WhatsApp renders these oversized with
// no bubble chrome instead of as normal chat text.
function isEmojiOnly(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  const stripped = trimmed.replace(/[‍️]/gu, "");
  const chars = Array.from(stripped);
  if (chars.length === 0 || chars.length > EMOJI_ONLY_MAX_CHARS) return false;
  return chars.every((ch) => /\p{Extended_Pictographic}/u.test(ch));
}

function StatusTick({ status }: { status: LocalMessage["status"] }) {
  if (status === "PENDING") return <span className="tick tick-pending">🕐</span>;
  if (status === "SENT") return <span className="tick">✓</span>;
  if (status === "DELIVERED") return <span className="tick">✓✓</span>;
  return <span className="tick tick-read">✓✓</span>; // READ
}

interface MessageBubbleProps {
  message: LocalMessage;
  onOpenViewOnce: (messageId: string) => void;
  onReply: (message: LocalMessage) => void;
  onDelete: (messageId: string) => void;
  showSender?: boolean;
}

export function MessageBubble({ message, onOpenViewOnce, onReply, onDelete, showSender }: MessageBubbleProps) {
  const [revealed, setRevealed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [dragX, setDragX] = useState(0);
  const [swiping, setSwiping] = useState(false);

  const dragState = useRef<{ pointerId: number; startX: number; startY: number; active: boolean; locked: boolean } | null>(
    null
  );

  const isVoice = message.kind === "VOICE";
  const isFile = message.kind === "FILE" && !!message.file;
  const isViewOnce = !!message.viewOnce && !isVoice;
  const isIncomingUnopened = isViewOnce && message.direction === "in" && !message.viewOnceOpened && !revealed;

  function handleTap() {
    if (!isIncomingUnopened) return;
    setRevealed(true);
    onOpenViewOnce(message.id);
  }

  function handlePointerDown(e: React.PointerEvent) {
    if (menuOpen) return;
    dragState.current = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, active: false, locked: false };
  }

  function handlePointerMove(e: React.PointerEvent) {
    const state = dragState.current;
    if (!state || e.pointerId !== state.pointerId) return;
    const dx = e.clientX - state.startX;
    const dy = e.clientY - state.startY;

    if (!state.locked) {
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
      // Only take over the gesture once it's clearly more horizontal than
      // vertical, so normal vertical scrolling of the message list still works.
      if (Math.abs(dy) > Math.abs(dx)) {
        state.locked = true;
        state.active = false;
        return;
      }
      state.locked = true;
      state.active = true;
      try {
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
      } catch {
        // Some environments (or synthetic pointers) can't capture — the
        // gesture still works, it just won't keep tracking past the element.
      }
    }
    if (!state.active) return;

    e.preventDefault();
    const clamped = Math.max(-SWIPE_MAX_PX, Math.min(SWIPE_MAX_PX, dx));
    setSwiping(true);
    setDragX(clamped);
  }

  function endDrag(e: React.PointerEvent) {
    const state = dragState.current;
    if (!state || e.pointerId !== state.pointerId) return;
    dragState.current = null;
    if (state.active && Math.abs(dragX) >= SWIPE_TRIGGER_PX) {
      onReply(message);
    }
    setSwiping(false);
    setDragX(0);
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // Not captured — nothing to release.
    }
  }

  let body: React.ReactNode = message.body;
  let bubbleClass = `bubble ${message.direction}`;

  if (isIncomingUnopened) {
    body = "📷 Tap to view";
    bubbleClass += " view-once-placeholder";
  } else if (message.direction === "in" && isViewOnce && message.viewOnceOpened && !revealed) {
    body = "🔥 Opened";
    bubbleClass += " view-once-placeholder";
  } else if (isVoice) {
    body = <audio controls preload="none" src={message.body} className="voice-player" />;
    bubbleClass += " voice-bubble";
  } else if (isFile && message.file) {
    const file = message.file;
    if (file.mime.startsWith("image/")) {
      body = (
        <a href={message.body} target="_blank" rel="noopener noreferrer" className="file-image-link">
          <img src={message.body} alt={file.name} className="file-image" />
        </a>
      );
      bubbleClass += " file-bubble file-bubble-image";
    } else {
      body = (
        <a href={message.body} download={file.name} className="file-card">
          <span className="file-card-icon">{fileIconFor(file.mime)}</span>
          <span className="file-card-info">
            <span className="file-card-name">{file.name}</span>
            <span className="file-card-size">{formatFileSize(file.size)}</span>
          </span>
        </a>
      );
      bubbleClass += " file-bubble";
    }
  } else if (isEmojiOnly(message.body)) {
    bubbleClass += " emoji-only";
  }

  return (
    <div className={`bubble-row ${message.direction}`}>
      <div
        className="msg-swipe-icon"
        style={{
          opacity: Math.min(1, Math.abs(dragX) / SWIPE_TRIGGER_PX),
          ...(dragX < 0 ? { left: "auto", right: 4 } : { left: 4, right: "auto" }),
        }}
      >
        ↩
      </div>
      <div
        className={bubbleClass}
        style={dragX ? { transform: `translateX(${dragX}px)`, transition: swiping ? "none" : "transform 0.15s ease" } : undefined}
        onClick={isIncomingUnopened ? handleTap : undefined}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        {showSender && message.direction === "in" && message.senderUsername && (
          <span className="group-sender-label">{message.senderUsername}</span>
        )}
        {message.replyTo && (
          <div className="reply-quote">
            <span className="reply-quote-sender">{message.replyTo.senderLabel}</span>
            <span className="reply-quote-preview">{message.replyTo.preview}</span>
          </div>
        )}
        {body}
        <span className="meta">
          {isViewOnce && <span className="view-once-badge">👁</span>}
          {formatTime(message.timestamp)}
          {message.direction === "out" && (
            <>
              {" "}
              {isViewOnce && message.viewOnceOpened ? (
                <span className="tick tick-read-label">Opened</span>
              ) : (
                <StatusTick status={message.status} />
              )}
            </>
          )}
        </span>

        <button
          type="button"
          className="msg-menu-trigger"
          onClick={(e) => {
            e.stopPropagation();
            setMenuOpen((v) => !v);
          }}
          aria-label="Message options"
        >
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.4">
            <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        {menuOpen && (
          <>
            <div className="menu-backdrop" onClick={() => setMenuOpen(false)} />
            <div className="dropdown-menu msg-dropdown-menu">
              <button
                className="dropdown-item msg-dropdown-item"
                onClick={() => {
                  setMenuOpen(false);
                  onReply(message);
                }}
              >
                <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <path d="M9 10 4 15l5 5" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M4 15h10.5a5.5 5.5 0 0 0 0-11H12" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                Reply
              </button>
              <button
                className="dropdown-item msg-dropdown-item danger"
                onClick={() => {
                  setMenuOpen(false);
                  onDelete(message.id);
                }}
              >
                <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <path d="M5 7h14" strokeLinecap="round" />
                  <path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M7 7l1 13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1l1-13" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M10 11v6M14 11v6" strokeLinecap="round" />
                </svg>
                Delete
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
