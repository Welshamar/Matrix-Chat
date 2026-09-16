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
}

export interface SignalReceiptPayload {
  messageId: string;
  status: "DELIVERED" | "READ";
}

export interface SocketAck {
  ok: boolean;
  error?: string;
  messageId?: string;
  clientMessageId?: string;
}
