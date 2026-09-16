import { createStore, get, set, del, keys, UseStore } from "idb-keyval";
import type {
  Direction,
  KeyPairType,
  SessionRecordType,
  StorageType,
} from "@privacyresearch/libsignal-protocol-typescript";

function arrayBuffersEqual(a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const av = new Uint8Array(a);
  const bv = new Uint8Array(b);
  for (let i = 0; i < av.length; i++) {
    if (av[i] !== bv[i]) return false;
  }
  return true;
}

/**
 * IndexedDB-backed implementation of the Signal Protocol `StorageType`,
 * scoped to one local user so multiple accounts can share a browser
 * without colliding. IndexedDB structured-clones ArrayBuffers natively,
 * so key material is stored as-is (no base64 round trip needed here).
 *
 * All private key + session (Double Ratchet) state lives ONLY in this
 * browser's IndexedDB. It is never sent to the server and this class is
 * the only thing that ever reads it.
 */
export class IndexedDbSignalStore implements StorageType {
  private readonly store: UseStore;

  constructor(userId: string) {
    this.store = createStore(`matrix-chat-signal-${userId}`, "keyval");
  }

  async put(key: string, value: unknown): Promise<void> {
    if (value === undefined) {
      throw new Error(`IndexedDbSignalStore.put: value for "${key}" is undefined`);
    }
    await set(key, value, this.store);
  }

  async get<T>(key: string, defaultValue?: T): Promise<T | undefined> {
    const value = await get<T>(key, this.store);
    return value === undefined ? defaultValue : value;
  }

  async remove(key: string): Promise<void> {
    await del(key, this.store);
  }

  /** Cheap existence check used to decide whether to run first-time key generation. */
  async hasIdentity(): Promise<boolean> {
    return (await this.getIdentityKeyPair()) !== undefined;
  }

  // --- Identity ---------------------------------------------------------

  async getIdentityKeyPair(): Promise<KeyPairType | undefined> {
    return this.get("identityKey");
  }

  async getLocalRegistrationId(): Promise<number | undefined> {
    return this.get("registrationId");
  }

  async isTrustedIdentity(
    identifier: string,
    identityKey: ArrayBuffer,
    _direction: Direction
  ): Promise<boolean> {
    const trusted = await this.get<ArrayBuffer>(`identityKey${identifier}`);
    if (!trusted) return true; // trust-on-first-use for a contact we've never seen
    return arrayBuffersEqual(trusted, identityKey);
  }

  async loadIdentityKey(identifier: string): Promise<ArrayBuffer | undefined> {
    return this.get(`identityKey${identifier}`);
  }

  /** Returns true if this identifier's identity key CHANGED — surface a safety warning when it does. */
  async saveIdentity(identifier: string, identityKey: ArrayBuffer): Promise<boolean> {
    const existing = await this.loadIdentityKey(identifier);
    await this.put(`identityKey${identifier}`, identityKey);
    return existing !== undefined && !arrayBuffersEqual(existing, identityKey);
  }

  // --- Prekeys ------------------------------------------------------------

  async loadPreKey(keyId: string | number): Promise<KeyPairType | undefined> {
    return this.get(`25519KeypreKey${keyId}`);
  }

  async storePreKey(keyId: string | number, keyPair: KeyPairType): Promise<void> {
    await this.put(`25519KeypreKey${keyId}`, keyPair);
  }

  async removePreKey(keyId: string | number): Promise<void> {
    await this.remove(`25519KeypreKey${keyId}`);
  }

  async loadSignedPreKey(keyId: string | number): Promise<KeyPairType | undefined> {
    return this.get(`25519KeysignedKey${keyId}`);
  }

  async storeSignedPreKey(keyId: string | number, keyPair: KeyPairType): Promise<void> {
    await this.put(`25519KeysignedKey${keyId}`, keyPair);
  }

  async removeSignedPreKey(keyId: string | number): Promise<void> {
    await this.remove(`25519KeysignedKey${keyId}`);
  }

  // --- Sessions (Double Ratchet state) ------------------------------------

  async loadSession(identifier: string): Promise<SessionRecordType | undefined> {
    return this.get(`session${identifier}`);
  }

  async storeSession(identifier: string, record: SessionRecordType): Promise<void> {
    await this.put(`session${identifier}`, record);
  }

  async removeSession(identifier: string): Promise<void> {
    await this.remove(`session${identifier}`);
  }

  async removeAllSessions(identifier: string): Promise<void> {
    const allKeys = await keys(this.store);
    await Promise.all(
      allKeys
        .filter((k) => typeof k === "string" && k.startsWith(`session${identifier}`))
        .map((k) => del(k, this.store))
    );
  }
}
