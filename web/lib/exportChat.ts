import { LocalMessage } from "./localDb";

// Plain-text transcript of this device's local message history -- there's
// no server-side copy to export from (see the module comment in localDb.ts),
// so this is necessarily "what this device currently has," same scope as
// everything else that reads local history.
export function buildChatTranscript(messages: LocalMessage[], threadName: string, myUsername: string): string {
  const lines = [`Matrix Chat export -- ${threadName}`, `Exported ${new Date().toLocaleString()}`, ""];
  for (const m of messages) {
    const who = m.direction === "out" ? myUsername : m.senderUsername ?? threadName;
    const when = new Date(m.timestamp).toLocaleString();
    let text: string;
    if (m.kind === "FILE") text = `[file: ${m.file?.name ?? "attachment"}]`;
    else if (m.kind === "VOICE") text = "[voice message]";
    else if (m.kind === "CALL") text = m.body;
    else text = m.viewOnce ? "[view-once message]" : m.body;
    lines.push(`[${when}] ${who}: ${text}`);
  }
  return lines.join("\n");
}

export function downloadTextFile(filename: string, content: string): void {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
