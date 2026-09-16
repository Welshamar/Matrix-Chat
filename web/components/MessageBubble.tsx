import { LocalMessage } from "@/lib/localDb";

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function statusLabel(status: LocalMessage["status"]): string {
  switch (status) {
    case "PENDING":
      return "Sending...";
    case "SENT":
      return "Sent";
    case "DELIVERED":
      return "Delivered";
    case "READ":
      return "Read";
    default:
      return "";
  }
}

export function MessageBubble({ message }: { message: LocalMessage }) {
  return (
    <div className={`bubble-row ${message.direction === "out" ? "out" : "in"}`}>
      <div className={`bubble ${message.direction === "out" ? "out" : "in"}`}>
        {message.body}
        <span className="meta">
          {formatTime(message.timestamp)}
          {message.direction === "out" ? ` · ${statusLabel(message.status)}` : ""}
        </span>
      </div>
    </div>
  );
}
