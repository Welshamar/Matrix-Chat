import { useState } from "react";
import { LocalMessage } from "@/lib/localDb";

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
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
}

export function MessageBubble({ message, onOpenViewOnce }: MessageBubbleProps) {
  const [revealed, setRevealed] = useState(false);

  const isViewOnce = !!message.viewOnce;
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
  }

  return (
    <div className={`bubble-row ${message.direction}`}>
      <div className={bubbleClass} onClick={isIncomingUnopened ? handleTap : undefined}>
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
