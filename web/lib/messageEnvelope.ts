// A reply-to reference or file metadata is packed into the plaintext itself
// (before Signal encryption) rather than sent as separate metadata, since
// the server only ever sees opaque ciphertext. The sentinel prefix lets the
// receiving side tell a wrapped envelope apart from a plain message (text or
// a voice-note data URL) without touching the wire format for messages that
// don't need either.

export interface ReplyRef {
  messageId: string;
  senderLabel: string;
  preview: string;
}

export interface FileMeta {
  name: string;
  mime: string;
  size: number;
}

export interface EnvelopeExtras {
  replyTo?: ReplyRef;
  file?: FileMeta;
}

const ENVELOPE_PREFIX = "MXREPLYv1:";

export function encodeEnvelope(text: string, extras?: EnvelopeExtras): string {
  if (!extras?.replyTo && !extras?.file) return text;
  return ENVELOPE_PREFIX + JSON.stringify({ t: text, r: extras.replyTo, f: extras.file });
}

export function decodeEnvelope(raw: string): { text: string; replyTo?: ReplyRef; file?: FileMeta } {
  if (!raw.startsWith(ENVELOPE_PREFIX)) return { text: raw };
  try {
    const parsed = JSON.parse(raw.slice(ENVELOPE_PREFIX.length));
    if (typeof parsed?.t === "string") {
      return { text: parsed.t, replyTo: parsed.r, file: parsed.f };
    }
  } catch {
    // Not a real envelope (or corrupted) — treat the whole thing as plain text.
  }
  return { text: raw };
}
