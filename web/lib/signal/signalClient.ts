import {
  KeyHelper,
  SessionBuilder,
  SessionCipher,
  SignalProtocolAddress,
} from "@privacyresearch/libsignal-protocol-typescript";
import type { PreKeyPairType } from "@privacyresearch/libsignal-protocol-typescript";
import { IndexedDbSignalStore } from "./IndexedDbStore";
import { arrayBufferToBase64, base64ToArrayBuffer, base64ToBinaryString, binaryStringToBase64 } from "./encoding";

const ONE_TIME_PREKEY_BATCH_SIZE = 100;
const DEFAULT_DEVICE_ID = 1;
export const PREKEY_WHISPER_MESSAGE_TYPE = 3; // first message of a new session
export const WHISPER_MESSAGE_TYPE = 1; // ordinary Double Ratchet message

export interface EncryptedEnvelope {
  ciphertext: string; // base64
  signalMessageType: number;
}

interface PreKeyBundleResponse {
  userId: string;
  registrationId: number;
  identityKey: string;
  signedPreKey: { keyId: number; publicKey: string; signature: string };
  preKey: { keyId: number; publicKey: string } | null;
}

async function apiRequest<T>(baseUrl: string, path: string, token: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...init?.headers,
    },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Request to ${path} failed with status ${res.status}`);
  }

  return res.json() as Promise<T>;
}

/**
 * Client-side wrapper around the Signal Protocol (X3DH + Double Ratchet)
 * for one local user. All private key/session material lives in
 * `IndexedDbSignalStore`, scoped to this browser; only base64 ciphertext
 * and public keys ever cross the network.
 */
export class SignalClient {
  readonly store: IndexedDbSignalStore;

  constructor(
    private readonly userId: string,
    private readonly authToken: string,
    private readonly apiBaseUrl: string
  ) {
    this.store = new IndexedDbSignalStore(userId);
  }

  /** True once this browser already holds an identity key for this user. */
  async hasLocalIdentity(): Promise<boolean> {
    return this.store.hasIdentity();
  }

  /**
   * First-time device setup: generates identity/signed/one-time prekeys,
   * keeps private halves in IndexedDB, and publishes public halves via
   * POST /api/keys/prekey-bundle. No-ops if an identity already exists
   * locally — call `hasLocalIdentity()` first if you need to decide.
   */
  async generateAndPublishBundle(): Promise<void> {
    const identityKeyPair = await KeyHelper.generateIdentityKeyPair();
    const registrationId = KeyHelper.generateRegistrationId();
    const signedPreKey = await KeyHelper.generateSignedPreKey(identityKeyPair, 1);

    const oneTimePreKeys: PreKeyPairType[] = [];
    for (let keyId = 1; keyId <= ONE_TIME_PREKEY_BATCH_SIZE; keyId++) {
      oneTimePreKeys.push(await KeyHelper.generatePreKey(keyId));
    }

    await this.store.put("identityKey", identityKeyPair);
    await this.store.put("registrationId", registrationId);
    await this.store.storeSignedPreKey(signedPreKey.keyId, signedPreKey.keyPair);
    await Promise.all(oneTimePreKeys.map((k) => this.store.storePreKey(k.keyId, k.keyPair)));

    await apiRequest(this.apiBaseUrl, "/api/keys/prekey-bundle", this.authToken, {
      method: "POST",
      body: JSON.stringify({
        registrationId,
        identityKey: arrayBufferToBase64(identityKeyPair.pubKey),
        signedPreKey: {
          keyId: signedPreKey.keyId,
          publicKey: arrayBufferToBase64(signedPreKey.keyPair.pubKey),
          signature: arrayBufferToBase64(signedPreKey.signature),
        },
        oneTimePreKeys: oneTimePreKeys.map((k) => ({
          keyId: k.keyId,
          publicKey: arrayBufferToBase64(k.keyPair.pubKey),
        })),
      }),
    });
  }

  /**
   * Runs X3DH against `recipientId`'s published bundle and persists the
   * resulting session if one doesn't already exist locally. Idempotent.
   */
  async ensureSession(recipientId: string): Promise<void> {
    const address = new SignalProtocolAddress(recipientId, DEFAULT_DEVICE_ID);
    const existing = await this.store.loadSession(address.toString());
    if (existing) return;

    const bundle = await apiRequest<PreKeyBundleResponse>(
      this.apiBaseUrl,
      `/api/keys/prekey-bundle/${recipientId}`,
      this.authToken,
      { method: "GET" }
    );

    const preKeyBundle = {
      identityKey: base64ToArrayBuffer(bundle.identityKey),
      registrationId: bundle.registrationId,
      signedPreKey: {
        keyId: bundle.signedPreKey.keyId,
        publicKey: base64ToArrayBuffer(bundle.signedPreKey.publicKey),
        signature: base64ToArrayBuffer(bundle.signedPreKey.signature),
      },
      preKey: bundle.preKey
        ? { keyId: bundle.preKey.keyId, publicKey: base64ToArrayBuffer(bundle.preKey.publicKey) }
        : undefined,
    };

    const builder = new SessionBuilder(this.store, address);
    await builder.processPreKey(preKeyBundle);
  }

  /** Encrypts `plaintext` for `recipientId`. Establishes a session first if needed. */
  async encryptMessage(recipientId: string, plaintext: string): Promise<EncryptedEnvelope> {
    await this.ensureSession(recipientId);

    const address = new SignalProtocolAddress(recipientId, DEFAULT_DEVICE_ID);
    const cipher = new SessionCipher(this.store, address);
    const plaintextBuffer = new TextEncoder().encode(plaintext).buffer;

    const ciphertext = await cipher.encrypt(plaintextBuffer);

    return {
      ciphertext: binaryStringToBase64(ciphertext.body as string),
      signalMessageType: ciphertext.type,
    };
  }

  /** Decrypts an inbound envelope from `senderId`, advancing that session's ratchet. */
  async decryptMessage(senderId: string, envelope: EncryptedEnvelope): Promise<string> {
    const address = new SignalProtocolAddress(senderId, DEFAULT_DEVICE_ID);
    const cipher = new SessionCipher(this.store, address);
    const body = base64ToBinaryString(envelope.ciphertext);

    const plaintextBuffer =
      envelope.signalMessageType === PREKEY_WHISPER_MESSAGE_TYPE
        ? await cipher.decryptPreKeyWhisperMessage(body, "binary")
        : await cipher.decryptWhisperMessage(body, "binary");

    return new TextDecoder().decode(plaintextBuffer);
  }
}
