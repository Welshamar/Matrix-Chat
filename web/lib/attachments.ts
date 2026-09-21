import { createStore, del, get, set, UseStore } from "idb-keyval";
import { API_URL } from "./api";

// Heavy files don't ride inside the chat message (one enormous socket frame
// starves the keepalive and gets the connection dropped mid-transfer, and every
// group member used to get a full copy). Instead the sender encrypts the file in
// 1 MiB chunks with a fresh random AES-256-GCM key, uploads the ciphertext over
// plain HTTP, and only a tiny pointer + the key travels inside the
// Signal-encrypted message. The server only ever stores opaque bytes.

export const CHUNK_BYTES = 1024 * 1024;
// Files above this are sent as attachments; smaller ones still go inline.
export const INLINE_MAX_BYTES = 2 * 1024 * 1024;
export const MAX_FILE_BYTES = 100 * 1024 * 1024;
// A received photo up to this size is fetched automatically so it shows in the
// chat like before; anything else waits for a tap.
export const AUTO_DOWNLOAD_IMAGE_MAX_BYTES = 25 * 1024 * 1024;

const IV_BYTES = 12;
const CONCURRENCY = 3;
const MAX_ATTEMPTS = 6;

/** What travels inside the encrypted message to locate and unlock the file. */
export interface AttachmentRef {
  id: string;
  // base64url AES-256 key.
  key: string;
  chunks: number;
}

export class AttachmentError extends Error {
  constructor(message: string, readonly code: "expired" | "cancelled" | "network" | "corrupt" | "rejected" | "auth") {
    super(message);
    this.name = "AttachmentError";
  }
}

let auth: { token: string; userId: string } | null = null;

/** Set once the user is logged in; the transfer functions use it for the bearer token and cache keys. */
export function setAttachmentAuth(next: { token: string; userId: string } | null): void {
  auth = next;
}

export function getAttachmentUserId(): string | null {
  return auth?.userId ?? null;
}

function requireAuth(): { token: string; userId: string } {
  if (!auth) throw new AttachmentError("You're signed out. Log in again to send or open files.", "auth");
  return auth;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Binds each chunk to its position and the file's chunk count, so the server
// (or anything in between) can't reorder, drop or splice chunks undetected.
function chunkAad(index: number, total: number): Uint8Array<ArrayBuffer> {
  const aad = new Uint8Array(8);
  const view = new DataView(aad.buffer);
  view.setUint32(0, index);
  view.setUint32(4, total);
  return aad;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AttachmentError("Cancelled.", "cancelled");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new AttachmentError("Cancelled.", "cancelled"));
      },
      { once: true }
    );
  });
}

// Phone connections drop and the free-tier server can be waking up, so a
// failed request is retried with backoff instead of failing a 100 MB transfer
// over one hiccup. Only errors that can't succeed on retry give up straight away.
async function requestWithRetry(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
  const { token } = requireAuth();
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    throwIfAborted(signal);
    try {
      const res = await fetch(url, {
        ...init,
        signal,
        headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${token}` },
      });
      if (res.ok) return res;
      if (res.status === 401) throw new AttachmentError("Your session expired. Log in again.", "auth");
      if (res.status === 404) throw new AttachmentError("This file has expired or is no longer available.", "expired");
      if (res.status !== 408 && res.status !== 429 && res.status < 500) {
        let detail = "";
        try {
          detail = ((await res.json()) as { error?: string }).error ?? "";
        } catch {
          // No JSON body -- fall through to the generic message.
        }
        throw new AttachmentError(detail || `The server rejected the transfer (${res.status}).`, "rejected");
      }
      lastError = new AttachmentError(`Server error (${res.status}).`, "network");
    } catch (err) {
      if (err instanceof AttachmentError && err.code !== "network") throw err;
      if (signal?.aborted) throw new AttachmentError("Cancelled.", "cancelled");
      lastError = err;
    }
    await sleep(Math.min(8000, 600 * 2 ** attempt), signal);
  }
  if (lastError instanceof AttachmentError) throw lastError;
  throw new AttachmentError("Connection problem -- check your internet and try again.", "network");
}

// Runs `worker(i)` for i in [0, count) with at most `limit` in flight; the
// first failure stops handing out new work and is rethrown.
async function runPool(count: number, limit: number, worker: (index: number) => Promise<void>): Promise<void> {
  let next = 0;
  let failure: unknown = null;
  const lanes = Array.from({ length: Math.min(limit, count) }, async () => {
    while (failure === null) {
      const index = next++;
      if (index >= count) return;
      try {
        await worker(index);
      } catch (err) {
        failure = failure ?? err;
        return;
      }
    }
  });
  await Promise.all(lanes);
  if (failure !== null) throw failure;
}

/** Encrypts and uploads `file`; resolves with the pointer to embed in the chat message. */
export async function uploadAttachment(
  file: Blob,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal
): Promise<AttachmentRef> {
  const total = Math.max(1, Math.ceil(file.size / CHUNK_BYTES));
  const cryptoKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
  const rawKey = new Uint8Array(await crypto.subtle.exportKey("raw", cryptoKey));

  const created = await requestWithRetry(
    `${API_URL}/api/attachments`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chunks: total, size: file.size + total * (IV_BYTES + 16) }),
    },
    signal
  );
  const { id } = (await created.json()) as { id: string };

  let done = 0;
  await runPool(total, CONCURRENCY, async (index) => {
    throwIfAborted(signal);
    const plain = await file.slice(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES).arrayBuffer();
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const sealed = new Uint8Array(
      await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: chunkAad(index, total) }, cryptoKey, plain)
    );
    const payload = new Uint8Array(IV_BYTES + sealed.length);
    payload.set(iv, 0);
    payload.set(sealed, IV_BYTES);

    await requestWithRetry(
      `${API_URL}/api/attachments/${id}/chunks/${index}`,
      { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: payload },
      signal
    );
    done++;
    onProgress?.(done / total);
  });

  await requestWithRetry(`${API_URL}/api/attachments/${id}/complete`, { method: "POST" }, signal);
  return { id, key: toBase64Url(rawKey), chunks: total };
}

/** Downloads and decrypts an attachment into a Blob of the given MIME type. */
export async function downloadAttachment(
  ref: AttachmentRef,
  mime: string,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal
): Promise<Blob> {
  const cryptoKey = await crypto.subtle.importKey("raw", fromBase64Url(ref.key), "AES-GCM", false, ["decrypt"]);
  const parts: ArrayBuffer[] = new Array(ref.chunks);
  let done = 0;

  await runPool(ref.chunks, CONCURRENCY, async (index) => {
    const res = await requestWithRetry(`${API_URL}/api/attachments/${ref.id}/chunks/${index}`, { method: "GET" }, signal);
    const payload = new Uint8Array(await res.arrayBuffer());
    if (payload.length <= IV_BYTES) throw new AttachmentError("This file is damaged.", "corrupt");
    try {
      parts[index] = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: payload.subarray(0, IV_BYTES), additionalData: chunkAad(index, ref.chunks) },
        cryptoKey,
        payload.subarray(IV_BYTES)
      );
    } catch {
      throw new AttachmentError("This file is damaged and couldn't be opened.", "corrupt");
    }
    done++;
    onProgress?.(done / ref.chunks);
  });

  return new Blob(parts, { type: mime });
}

// ---- local copies -----------------------------------------------------------
// The server drops files after 14 days and the message keys are gone once used,
// so once a file has been downloaded (or sent) the decrypted copy is kept on
// this device, keyed by message.

let blobStore: UseStore | null = null;
function store(): UseStore {
  if (!blobStore) blobStore = createStore("matrix-chat-files", "blobs");
  return blobStore;
}

function cacheKey(userId: string, messageId: string): string {
  return `${userId}:${messageId}`;
}

export async function getCachedFile(userId: string, messageId: string): Promise<Blob | undefined> {
  try {
    return await get<Blob>(cacheKey(userId, messageId), store());
  } catch {
    return undefined;
  }
}

export async function cacheFile(userId: string, messageId: string, blob: Blob): Promise<void> {
  try {
    await set(cacheKey(userId, messageId), blob, store());
  } catch {
    // Storage full or unavailable: the file just isn't kept locally, and will
    // be fetched again from the server next time (while it's still there).
  }
}

export async function deleteCachedFile(userId: string, messageId: string): Promise<void> {
  try {
    await del(cacheKey(userId, messageId), store());
  } catch {
    // Nothing to clean up.
  }
}

// ---- shared, de-duplicated loads ---------------------------------------------
// A bubble can mount, unmount and remount while a big file is still coming down
// (scrolling, switching chats). Loads are shared per message so that never
// starts a second download, and any bubble can listen for progress.

interface InflightLoad {
  promise: Promise<Blob>;
  listeners: Set<(fraction: number) => void>;
  controller: AbortController;
  last: number;
}

const inflight = new Map<string, InflightLoad>();

export function loadAttachmentFile(
  messageId: string,
  ref: AttachmentRef,
  mime: string,
  onProgress?: (fraction: number) => void
): Promise<Blob> {
  const { userId } = requireAuth();
  const key = cacheKey(userId, messageId);
  const existing = inflight.get(key);
  if (existing) {
    if (onProgress) {
      existing.listeners.add(onProgress);
      onProgress(existing.last);
    }
    return existing.promise;
  }

  const listeners = new Set<(fraction: number) => void>();
  if (onProgress) listeners.add(onProgress);
  const controller = new AbortController();
  const load: InflightLoad = { listeners, controller, last: 0, promise: null as unknown as Promise<Blob> };

  load.promise = (async () => {
    try {
      const cached = await getCachedFile(userId, messageId);
      if (cached) return cached;
      const blob = await downloadAttachment(
        ref,
        mime,
        (fraction) => {
          load.last = fraction;
          listeners.forEach((l) => l(fraction));
        },
        controller.signal
      );
      await cacheFile(userId, messageId, blob);
      return blob;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, load);
  return load.promise;
}
