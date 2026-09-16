import { useState } from "react";
import { LocalMessage } from "@/lib/localDb";

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

const EMOJI_ONLY_MAX_CHARS = 12;

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
  showSender?: boolean;
}

export function MessageBubble({ message, onOpenViewOnce, showSender }: MessageBubbleProps) {
  const [revealed, setRevealed] = useState(false);

  const isVoice = message.kind === "VOICE";
  const isViewOnce = !!message.viewOnce && !isVoice;
  const isIncomingUnopened = isViewOnce && message.direction === "in" && !message.viewOnceOpened && !revealed;

  function handleTap() {
    if (!isIncomingUnopened) return;
    setRevealed(true);
    onOpenViewOnce(message.id);
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
  } else if (isEmojiOnly(message.body)) {
    bubbleClass += " emoji-only";
  }

  return (
    <div className={`bubble-row ${message.direction}`}>
      <div className={bubbleClass} onClick={isIncomingUnopened ? handleTap : undefined}>
        {showSender && message.direction === "in" && message.senderUsername && (
          <span className="group-sender-label">{message.senderUsername}</span>
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
      </div>
    </div>
  );
}
