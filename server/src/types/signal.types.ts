/** Public-key-only payload a client publishes so others can start X3DH sessions with it. */
export interface UploadPreKeyBundleDTO {
  registrationId: number;
  identityKey: string; // base64 Curve25519 public key
  signedPreKey: {
    keyId: number;
    publicKey: string; // base64
    signature: string; // base64, signed by the identity key
  };
  oneTimePreKeys: Array<{ keyId: number; publicKey: string }>;
}

/** What a client fetches to initiate a session with `userId`. */
export interface PreKeyBundleDTO {
  userId: string;
  registrationId: number;
  identityKey: string;
  signedPreKey: {
    keyId: number;
    publicKey: string;
    signature: string;
  };
  // null once the recipient's one-time prekeys have all been consumed;
  // X3DH can still proceed with signed-prekey-only, at reduced forward secrecy.
  preKey: { keyId: number; publicKey: string } | null;
}

export interface SignalMessagePayload {
  recipientId: string;
  ciphertext: string; // base64 — opaque to the server
  signalMessageType: number; // 3 = PreKeyWhisperMessage, 1 = WhisperMessage
  clientMessageId?: string;
  viewOnce?: boolean;
  kind?: "TEXT" | "VOICE" | "FILE";
  // Present for a group send: this row is one member's individual
  // pairwise-encrypted copy (see the Message model for why there's no
  // separate group encryption scheme), tagged so recipients can file it
  // into the right group thread.
  groupId?: string;
}

export interface SignalReceiptPayload {
  messageId: string;
  status: "DELIVERED" | "READ";
}

/** Sent by the recipient once a view-once message has been shown; tells the
 *  server to discard the ciphertext and tells the sender it was consumed. */
export interface SignalViewedPayload {
  messageId: string;
}

export interface SocketAck {
  ok: boolean;
  error?: string;
  messageId?: string;
  clientMessageId?: string;
}
