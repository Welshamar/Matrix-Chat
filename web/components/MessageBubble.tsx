import { memo, useEffect, useRef, useState } from "react";
import { LocalMessage } from "@/lib/localDb";
import { saveDataUrlFile, shareDataUrlFile } from "@/lib/saveFile";
import { useAttachment } from "@/lib/useAttachment";
import { VoiceMessagePlayer } from "./VoiceMessagePlayer";

// How long a just-opened view-once photo stays visible before collapsing
// back to the "Opened" placeholder — long enough to actually look at it,
// short enough that it reads as a genuine one-time reveal rather than a
// message that just quietly stays viewable for the rest of the session.
const VIEW_ONCE_DISPLAY_MS = 8000;

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface FileBadge {
  label: string;
  colorClass: string;
}

// WhatsApp's document card badges the file with its extension on a colored
// square rather than a generic paper icon — the extension (from the
// filename, which is more reliable than a possibly-generic MIME type like
// application/octet-stream) reads as useful information at a glance.
function fileBadgeFor(filename: string, mime: string): FileBadge {
  const ext = (filename.split(".").pop() || "").toUpperCase().slice(0, 4);
  if (mime.startsWith("video/")) return { label: ext || "VID", colorClass: "file-badge-video" };
  if (mime.startsWith("audio/")) return { label: ext || "AUD", colorClass: "file-badge-audio" };
  if (mime === "application/pdf") return { label: "PDF", colorClass: "file-badge-pdf" };
  if (mime.includes("word") || mime.includes("document")) return { label: ext || "DOC", colorClass: "file-badge-doc" };
  if (mime.includes("sheet") || mime.includes("excel")) return { label: ext || "XLS", colorClass: "file-badge-sheet" };
  // Checked before the generic archive case below — Android's own MIME
  // type for an APK ("application/vnd.android.package-archive") contains
  // the substring "archive", which would otherwise misclassify it as ZIP.
  if (mime.includes("android.package-archive") || ext === "APK") return { label: "APK", colorClass: "file-badge-apk" };
  if (mime.includes("zip") || mime.includes("compressed") || mime.includes("archive")) {
    return { label: ext || "ZIP", colorClass: "file-badge-archive" };
  }
  return { label: ext || "FILE", colorClass: "file-badge-generic" };
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

function ShareIcon() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="18" cy="5.5" r="2.5" />
      <circle cx="6" cy="12" r="2.5" />
      <circle cx="18" cy="18.5" r="2.5" />
      <path d="M8.2 10.7l7.6-4.2M8.2 13.3l7.6 4.2" strokeLinecap="round" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M12 3.5v11.5" strokeLinecap="round" />
      <path d="M7.5 11l4.5 4.5 4.5-4.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5 19.5h14" strokeLinecap="round" />
    </svg>
  );
}

interface MessageBubbleProps {
  message: LocalMessage;
  onOpenViewOnce: (messageId: string) => void;
  onReply: (message: LocalMessage) => void;
  onDelete: (messageId: string) => void;
  onViewImage?: (message: LocalMessage) => void;
  showSender?: boolean;
  // Who the voice-note avatar shows (the sender of this message). Plain
  // strings rather than an object so the memoized bubble stays memoized.
  avatarName?: string;
  avatarUrl?: string | null;
  // "Select messages" mode: while active, tapping the row toggles selection
  // instead of its normal behavior (reply-swipe, view-once tap, etc).
  selectable?: boolean;
  selected?: boolean;
  onToggleSelect?: (messageId: string) => void;
  // In-chat search: non-empty while a search is active, wraps each match in
  // <mark>; `isActiveMatch` additionally rings the currently-focused result
  // so scrollIntoView has something visually obvious to land on.
  highlightQuery?: string;
  isActiveMatch?: boolean;
}

function highlightText(text: string, query: string): React.ReactNode {
  const q = query.trim();
  if (!q) return text;
  const lower = text.toLowerCase();
  const lowerQ = q.toLowerCase();
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  let idx = lower.indexOf(lowerQ);
  if (idx === -1) return text;
  while (idx !== -1) {
    parts.push(text.slice(cursor, idx));
    parts.push(
      <mark key={idx} className="search-highlight">
        {text.slice(idx, idx + q.length)}
      </mark>
    );
    cursor = idx + q.length;
    idx = lower.indexOf(lowerQ, cursor);
  }
  parts.push(text.slice(cursor));
  return parts;
}

// Memoized — the parent chat page is one large component that re-renders
// on every keystroke and on unrelated state like typing indicators; without
// this, every message bubble in the whole thread re-executes on every one
// of those renders, which is what made typing feel laggy once the other
// side's typing status started updating on top of your own keystrokes.
function MessageBubbleImpl({
  message,
  onOpenViewOnce,
  onReply,
  onDelete,
  onViewImage,
  showSender,
  avatarName,
  avatarUrl,
  selectable,
  selected,
  onToggleSelect,
  highlightQuery,
  isActiveMatch,
}: MessageBubbleProps) {
  const [revealed, setRevealed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [dragX, setDragX] = useState(0);
  const [swiping, setSwiping] = useState(false);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  // Heavy files live on the server as an encrypted attachment; this tracks
  // whether the decrypted copy is on this device yet (and downloads it on demand).
  const attachment = useAttachment(message);

  const dragState = useRef<{ pointerId: number; startX: number; startY: number; active: boolean; locked: boolean } | null>(
    null
  );
  const revealTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveStatusTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (revealTimeoutRef.current) clearTimeout(revealTimeoutRef.current);
      if (saveStatusTimeoutRef.current) clearTimeout(saveStatusTimeoutRef.current);
    };
  }, []);

  const isVoice = message.kind === "VOICE";
  const isFile = message.kind === "FILE" && !!message.file;
  const isViewOnce = !!message.viewOnce && !isVoice;
  const isIncomingUnopened = isViewOnce && message.direction === "in" && !message.viewOnceOpened && !revealed;

  function flashSaveStatus(text: string) {
    setSaveStatus(text);
    if (saveStatusTimeoutRef.current) clearTimeout(saveStatusTimeoutRef.current);
    saveStatusTimeoutRef.current = setTimeout(() => setSaveStatus(null), 4000);
  }

  // Where the file's bytes can be read from: the inline data URL for a small
  // file, or a URL for the decrypted attachment (downloading it first if it
  // isn't on this device yet). Null if that download failed.
  async function resolveFileSource(): Promise<string | null> {
    if (!message.file?.att) return message.body;
    const blob = attachment.blob ?? (await attachment.ensure());
    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    setTimeout(() => URL.revokeObjectURL(url), 5 * 60 * 1000);
    return url;
  }

  async function handleDownload() {
    if (!message.file) return;
    setSaveStatus(message.file.att && !attachment.blob ? "Downloading..." : "Saving...");
    const source = await resolveFileSource();
    if (!source) {
      flashSaveStatus("Couldn't download the file. Check your connection and try again.");
      return;
    }
    const result = await saveDataUrlFile(source, message.file.name);
    if (result.message) flashSaveStatus(result.message);
    else setSaveStatus(null);
  }

  async function handleShare() {
    if (!message.file) return;
    const source = await resolveFileSource();
    if (!source) {
      flashSaveStatus("Couldn't download the file. Check your connection and try again.");
      return;
    }
    const result = await shareDataUrlFile(source, message.file.name);
    if (!result.ok && result.message) flashSaveStatus(result.message);
  }

  function handleTap() {
    if (!isIncomingUnopened) return;
    setRevealed(true);
    onOpenViewOnce(message.id);
    revealTimeoutRef.current = setTimeout(() => setRevealed(false), VIEW_ONCE_DISPLAY_MS);
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

  if (message.kind === "CALL") {
    return (
      <div className="call-log-row">
        <span className="call-log-pill">
          {message.body} · {formatTime(message.timestamp)}
        </span>
      </div>
    );
  }

  let body: React.ReactNode = highlightQuery ? highlightText(message.body, highlightQuery) : message.body;
  let bubbleClass = `bubble ${message.direction}`;

  if (isIncomingUnopened) {
    body = "📷 Tap to view";
    bubbleClass += " view-once-placeholder";
  } else if (message.direction === "in" && isViewOnce && message.viewOnceOpened && !revealed) {
    body = "🔥 Opened";
    bubbleClass += " view-once-placeholder";
  } else if (isVoice) {
    body = (
      <VoiceMessagePlayer
        messageId={message.id}
        src={message.body}
        avatarName={avatarName ?? message.senderUsername ?? "?"}
        avatarUrl={avatarUrl}
        direction={message.direction}
      />
    );
    bubbleClass += " voice-bubble";
  } else if (isFile && message.file) {
    const file = message.file;
    if (file.mime.startsWith("image/") && file.att && !attachment.url) {
      // Photo is on the server but not on this device yet (still downloading,
      // failed, or too big to fetch without asking).
      const busy = attachment.status === "downloading" || attachment.status === "checking";
      body = (
        <div className="file-image-wrap">
          <button
            type="button"
            className="file-image-pending"
            disabled={busy}
            onClick={(e) => {
              e.stopPropagation();
              attachment.ensure();
            }}
            aria-label={`Download ${file.name}`}
          >
            {busy ? (
              <>
                <span className="file-spinner" aria-hidden="true" />
                <span>{attachment.status === "downloading" ? `${Math.round(attachment.progress * 100)}%` : "Loading…"}</span>
              </>
            ) : attachment.status === "error" ? (
              <span>{attachment.error ?? "Couldn't load the photo."} Tap to retry.</span>
            ) : (
              <span>Tap to download · {formatFileSize(file.size)}</span>
            )}
          </button>
        </div>
      );
      bubbleClass += " file-bubble file-bubble-image";
    } else if (file.mime.startsWith("image/")) {
      const imageSrc = file.att ? attachment.url : message.body;
      body = (
        <div className="file-image-wrap">
          <button
            type="button"
            className="file-image-link"
            onClick={(e) => {
              e.stopPropagation();
              onViewImage?.(file.att ? { ...message, body: imageSrc ?? "" } : message);
            }}
            aria-label={`Open ${file.name}`}
          >
            <img src={imageSrc ?? ""} alt={file.name} className="file-image" />
          </button>
          <div className="file-image-actions">
            <button
              type="button"
              className="file-image-action-btn"
              onClick={(e) => {
                e.stopPropagation();
                handleShare();
              }}
              aria-label="Share image"
              title="Share"
            >
              <ShareIcon />
            </button>
            <button
              type="button"
              className="file-image-action-btn"
              onClick={(e) => {
                e.stopPropagation();
                handleDownload();
              }}
              aria-label="Download image"
              title="Download"
            >
              <DownloadIcon />
            </button>
          </div>
          {saveStatus && <div className="file-save-status">{saveStatus}</div>}
        </div>
      );
      bubbleClass += " file-bubble file-bubble-image";
    } else {
      const badge = fileBadgeFor(file.name, file.mime);
      body = (
        <div className="file-card">
          <span className={`file-card-badge ${badge.colorClass}`}>{badge.label}</span>
          <span className="file-card-info">
            <span className="file-card-name">{file.name}</span>
            <span className="file-card-size">{formatFileSize(file.size)}</span>
            {attachment.status === "downloading" && (
              <span className="file-transfer">
                <span className="file-transfer-bar">
                  <span className="file-transfer-fill" style={{ width: `${Math.round(attachment.progress * 100)}%` }} />
                </span>
                <span className="file-transfer-pct">{Math.round(attachment.progress * 100)}%</span>
              </span>
            )}
            {attachment.status === "error" && !saveStatus && <span className="file-save-status">{attachment.error}</span>}
            {saveStatus && <span className="file-save-status">{saveStatus}</span>}
          </span>
          <span className="file-card-actions">
            <button
              type="button"
              className="file-card-action-btn"
              onClick={(e) => {
                e.stopPropagation();
                handleShare();
              }}
              aria-label="Share file"
              title="Share"
            >
              <ShareIcon />
            </button>
            <button
              type="button"
              className="file-card-action-btn"
              onClick={(e) => {
                e.stopPropagation();
                handleDownload();
              }}
              disabled={attachment.status === "downloading"}
              aria-label="Download file"
              title="Download"
            >
              <DownloadIcon />
            </button>
          </span>
        </div>
      );
      bubbleClass += " file-bubble";
    }
  } else if (isEmojiOnly(message.body)) {
    bubbleClass += " emoji-only";
  }

  return (
    <div id={`msg-${message.id}`} className={`bubble-row ${message.direction} ${isActiveMatch ? "search-match-active" : ""}`}>
      {selectable && (
        <button
          type="button"
          className={`msg-select-checkbox ${selected ? "checked" : ""}`}
          onClick={() => onToggleSelect?.(message.id)}
          aria-label={selected ? "Deselect message" : "Select message"}
          aria-pressed={selected}
        >
          {selected && (
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="3">
              <path d="M5 12l5 5 9-11" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </button>
      )}
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
        onClick={selectable ? () => onToggleSelect?.(message.id) : isIncomingUnopened ? handleTap : undefined}
        onPointerDown={selectable ? undefined : handlePointerDown}
        onPointerMove={selectable ? undefined : handlePointerMove}
        onPointerUp={selectable ? undefined : endDrag}
        onPointerCancel={selectable ? undefined : endDrag}
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

        {!selectable && (
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
        )}
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

export const MessageBubble = memo(MessageBubbleImpl);
