// A reply-to reference is packed into the plaintext itself (before Signal
// encryption) rather than sent as separate metadata, since the server only
// ever sees opaque ciphertext. The sentinel prefix lets the receiving side
// tell a wrapped envelope apart from a plain message (text or a voice-note
// data URL) without touching the wire format for messages that aren't replies.

export interface ReplyRef {
  messageId: string;
  senderLabel: string;
  preview: string;
}

const REPLY_PREFIX = "MXREPLYv1:";

export function encodeEnvelope(text: string, replyTo?: ReplyRef): string {
  if (!replyTo) return text;
  return REPLY_PREFIX + JSON.stringify({ t: text, r: replyTo });
}

export function decodeEnvelope(raw: string): { text: string; replyTo?: ReplyRef } {
  if (!raw.startsWith(REPLY_PREFIX)) return { text: raw };
  try {
    const parsed = JSON.parse(raw.slice(REPLY_PREFIX.length));
    if (typeof parsed?.t === "string") {
      return { text: parsed.t, replyTo: parsed.r };
    }
  } catch {
    // Not a real envelope (or corrupted) — treat the whole thing as plain text.
  }
  return { text: raw };
}
