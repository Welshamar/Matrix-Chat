import { createStore, get, set, UseStore } from "idb-keyval";

/**
 * Local, per-browser cache of decrypted chat history and the conversation
 * list. This is NOT the source of truth for anything security-relevant —
 * the server never sees plaintext. It exists only because the Double
 * Ratchet deletes message keys after use (forward secrecy), so a message
 * generally can't be re-decrypted after the fact; the plaintext has to be
 * saved locally the moment it's produced (sent or decrypted) if you want
 * chat history to survive a reload.
 */

export type MessageDirection = "in" | "out";
export type MessageStatus = "PENDING" | "SENT" | "DELIVERED" | "READ";

export interface LocalMessage {
  id: string;
  direction: MessageDirection;
  body: string;
  timestamp: string;
  status: MessageStatus;
  viewOnce?: boolean;
  // For an incoming view-once message: whether the user has opened it yet
  // (controls the blurred "tap to view" placeholder). For an outgoing one:
  // whether the recipient has opened it (drives an "Opened" label).
  viewOnceOpened?: boolean;
}

export interface Conversation {
  peerId: string;
  peerUsername: string;
  peerAvatarUrl?: string | null;
  lastMessage: string;
  lastTimestamp: string;
  favourite?: boolean;
  unreadCount?: number;
}

const MAX_MESSAGES_PER_CONVERSATION = 500;

// Separate physical databases per concern — idb-keyval's createStore()
// only creates its named object store during that database's initial
// version-upgrade, so two createStore() calls sharing one db name but
// different store names would leave the second store missing.
//
// createStore() must also be memoized per (dbName, storeName): each call
// opens its own IndexedDB connection, and firing several fresh opens of a
// database that doesn't exist yet races the one-time version-upgrade
// transaction that creates the object store, intermittently throwing
// "object store not found" on whichever call loses the race.
const messagesStoreCache = new Map<string, UseStore>();
const metaStoreCache = new Map<string, UseStore>();

function messagesStore(userId: string): UseStore {
  let store = messagesStoreCache.get(userId);
  if (!store) {
    store = createStore(`matrix-chat-messages-${userId}`, "messages");
    messagesStoreCache.set(userId, store);
  }
  return store;
}

function metaStore(userId: string): UseStore {
  let store = metaStoreCache.get(userId);
  if (!store) {
    store = createStore(`matrix-chat-meta-${userId}`, "meta");
    metaStoreCache.set(userId, store);
  }
  return store;
}

export async function getMessages(userId: string, peerId: string): Promise<LocalMessage[]> {
  return (await get<LocalMessage[]>(`conv:${peerId}`, messagesStore(userId))) ?? [];
}

export async function appendMessage(userId: string, peerId: string, message: LocalMessage): Promise<void> {
  const existing = await getMessages(userId, peerId);
  const updated = [...existing, message].slice(-MAX_MESSAGES_PER_CONVERSATION);
  await set(`conv:${peerId}`, updated, messagesStore(userId));
}

export async function updateMessageStatus(
  userId: string,
  peerId: string,
  messageId: string,
  status: MessageStatus
): Promise<void> {
  const existing = await getMessages(userId, peerId);
  const updated = existing.map((m) => (m.id === messageId ? { ...m, status } : m));
  await set(`conv:${peerId}`, updated, messagesStore(userId));
}

export async function markViewOnceOpened(userId: string, peerId: string, messageId: string): Promise<void> {
  const existing = await getMessages(userId, peerId);
  const updated = existing.map((m) => (m.id === messageId ? { ...m, viewOnceOpened: true } : m));
  await set(`conv:${peerId}`, updated, messagesStore(userId));
}

export async function getConversations(userId: string): Promise<Conversation[]> {
  return (await get<Conversation[]>("conversations", metaStore(userId))) ?? [];
}

// Merges into any existing record for `patch.peerId` rather than replacing
// it outright, so a partial update (e.g. just bumping unreadCount) doesn't
// clobber fields like `favourite` that weren't part of this particular call.
export async function upsertConversation(
  userId: string,
  patch: Partial<Conversation> & { peerId: string }
): Promise<void> {
  const existing = await getConversations(userId);
  const current = existing.find((c) => c.peerId === patch.peerId);
  const merged: Conversation = {
    peerId: patch.peerId,
    peerUsername: patch.peerUsername ?? current?.peerUsername ?? "",
    peerAvatarUrl: patch.peerAvatarUrl ?? current?.peerAvatarUrl ?? null,
    lastMessage: patch.lastMessage ?? current?.lastMessage ?? "",
    lastTimestamp: patch.lastTimestamp ?? current?.lastTimestamp ?? new Date().toISOString(),
    favourite: patch.favourite ?? current?.favourite ?? false,
    unreadCount: patch.unreadCount ?? current?.unreadCount ?? 0,
  };
  const others = existing.filter((c) => c.peerId !== patch.peerId);
  const updated = [merged, ...others].sort(
    (a, b) => new Date(b.lastTimestamp).getTime() - new Date(a.lastTimestamp).getTime()
  );
  await set("conversations", updated, metaStore(userId));
}

export async function toggleFavourite(userId: string, peerId: string): Promise<void> {
  const existing = await getConversations(userId);
  const current = existing.find((c) => c.peerId === peerId);
  if (!current) return;
  await upsertConversation(userId, { peerId, favourite: !current.favourite });
}

export async function incrementUnread(userId: string, peerId: string): Promise<void> {
  const existing = await getConversations(userId);
  const current = existing.find((c) => c.peerId === peerId);
  await upsertConversation(userId, { peerId, unreadCount: (current?.unreadCount ?? 0) + 1 });
}

export async function clearUnread(userId: string, peerId: string): Promise<void> {
  await upsertConversation(userId, { peerId, unreadCount: 0 });
}

export async function getContactUsername(userId: string, peerId: string): Promise<string | undefined> {
  const conversations = await getConversations(userId);
  return conversations.find((c) => c.peerId === peerId)?.peerUsername;
}
