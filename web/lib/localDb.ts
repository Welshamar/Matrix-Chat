import { createStore, del, get, set, update, UseStore } from "idb-keyval";
import { FileMeta, ReplyRef } from "./messageEnvelope";

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

// "CALL" is local-only — a call-outcome log entry (missed/no-answer/
// duration) each side writes to its own history, never sent over the wire
// (see logCallOutcome in app/chat/page.tsx and call.gateway.ts).
export type MessageKind = "TEXT" | "VOICE" | "FILE" | "CALL";

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
  kind?: MessageKind;
  // Group threads have more than one possible sender for an "in" message,
  // so each one carries who actually sent it (unused for 1:1 threads).
  senderId?: string;
  senderUsername?: string;
  replyTo?: ReplyRef;
  // Only present for kind "FILE" — `body` is the data URL itself, this is
  // the original file's metadata (the data URL alone loses the filename).
  file?: FileMeta;
  // "Disappearing messages": set at append time from the thread's current
  // disappearingSeconds setting (see setDisappearingTimer). This is a
  // declutter feature, not a security one -- the server already never
  // retains plaintext regardless -- so a plain client-side timestamp
  // checked by getMessages() is all that's needed.
  expiresAt?: string;
}

// Curated background choices for "Chat theme" -- a key stored on the
// Conversation/LocalGroup record, resolved to actual CSS in globals.css.
export const CHAT_THEMES = ["default", "teal", "sunset", "violet", "forest", "slate"] as const;
export type ChatTheme = (typeof CHAT_THEMES)[number];

export interface Conversation {
  peerId: string;
  peerUsername: string;
  peerAvatarUrl?: string | null;
  lastMessage: string;
  lastTimestamp: string;
  favourite?: boolean;
  unreadCount?: number;
  muted?: boolean;
  disappearingSeconds?: number | null;
  theme?: ChatTheme;
  lists?: string[];
}

export type GroupRole = "ADMIN" | "MEMBER";

export interface LocalGroupMember {
  userId: string;
  username: string;
  avatarUrl?: string | null;
  role: GroupRole;
}

export interface LocalGroup {
  groupId: string;
  name: string;
  avatarUrl?: string | null;
  members: LocalGroupMember[];
  lastMessage: string;
  lastTimestamp: string;
  favourite?: boolean;
  unreadCount?: number;
  muted?: boolean;
  disappearingSeconds?: number | null;
  theme?: ChatTheme;
  lists?: string[];
}

// Group message history reuses getMessages/appendMessage/etc. below under
// the key `group:<groupId>` instead of a peerId — they're keyed by an
// arbitrary string, so no separate storage functions are needed.
export function groupThreadKey(groupId: string): string {
  return `group:${groupId}`;
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

// Self-healing on read: any message whose disappearing-messages timer has
// elapsed is dropped here and the trimmed list is written back, so no
// separate background sweep timer is needed -- opening/refreshing a thread
// is already enough to keep it current.
export async function getMessages(userId: string, peerId: string): Promise<LocalMessage[]> {
  const all = (await get<LocalMessage[]>(`conv:${peerId}`, messagesStore(userId))) ?? [];
  const now = Date.now();
  const live = all.filter((m) => !m.expiresAt || new Date(m.expiresAt).getTime() > now);
  if (live.length !== all.length) await set(`conv:${peerId}`, live, messagesStore(userId));
  return live;
}

// Centralized here (rather than at each of appendMessage's many call sites
// in app/chat/page.tsx -- outgoing text, incoming text, files, voice notes,
// call-log entries, both 1:1 and group) so a disappearing-messages timer
// can never be silently skipped for one message type by an omission at a
// call site.
async function attachExpiry(userId: string, threadKey: string, message: LocalMessage): Promise<LocalMessage> {
  if (message.expiresAt) return message;
  const seconds = threadKey.startsWith("group:")
    ? (await getGroups(userId)).find((g) => g.groupId === threadKey.slice("group:".length))?.disappearingSeconds
    : (await getConversations(userId)).find((c) => c.peerId === threadKey)?.disappearingSeconds;
  if (!seconds) return message;
  return { ...message, expiresAt: new Date(Date.now() + seconds * 1000).toISOString() };
}

export async function appendMessage(userId: string, peerId: string, message: LocalMessage): Promise<void> {
  const existing = await getMessages(userId, peerId);
  const withExpiry = await attachExpiry(userId, peerId, message);
  const updated = [...existing, withExpiry].slice(-MAX_MESSAGES_PER_CONVERSATION);
  await set(`conv:${peerId}`, updated, messagesStore(userId));
}

const STATUS_RANK: Record<MessageStatus, number> = { PENDING: 0, SENT: 1, DELIVERED: 2, READ: 3 };

// Two things here matter. The status only ever moves forward: when the
// recipient already has the thread open they send "read" and then "delivered"
// for the same message, and applying them in that order used to knock a read
// message back to grey ticks. And update() does the read and the write inside
// one IndexedDB transaction -- with a separate get() then set(), two receipts
// landing together each wrote back a stale copy of the thread and one
// silently overwrote the other.
export async function updateMessageStatus(
  userId: string,
  peerId: string,
  messageId: string,
  status: MessageStatus
): Promise<void> {
  await update<LocalMessage[]>(
    `conv:${peerId}`,
    (existing) =>
      (existing ?? []).map((m) =>
        m.id === messageId && STATUS_RANK[status] > STATUS_RANK[m.status] ? { ...m, status } : m
      ),
    messagesStore(userId)
  );
}

export async function markViewOnceOpened(userId: string, peerId: string, messageId: string): Promise<void> {
  const existing = await getMessages(userId, peerId);
  const updated = existing.map((m) => (m.id === messageId ? { ...m, viewOnceOpened: true } : m));
  await set(`conv:${peerId}`, updated, messagesStore(userId));
}

// "Delete for me": removes the message from this device's local cache only.
// There is no server-side message store to delete from — the relay never
// retains plaintext, and delivered ciphertext is already gone from the inbox.
export async function deleteMessage(userId: string, peerId: string, messageId: string): Promise<void> {
  const existing = await getMessages(userId, peerId);
  const updated = existing.filter((m) => m.id !== messageId);
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
    muted: patch.muted ?? current?.muted ?? false,
    // "in patch" (not ??) because turning disappearing messages OFF means
    // explicitly patching in `null`, which -- unlike every other field here
    // -- must NOT fall through to the existing value the way ?? would.
    disappearingSeconds: "disappearingSeconds" in patch ? patch.disappearingSeconds : current?.disappearingSeconds ?? null,
    theme: patch.theme ?? current?.theme ?? "default",
    lists: patch.lists ?? current?.lists ?? [],
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

// Local half of muting -- suppresses this device's own notification sound
// for the thread. The server independently tracks the same mute (see
// muteThread/unmuteThread in lib/api.ts) so it can also skip a push
// notification while the app isn't in the foreground at all.
export async function setConversationMuted(userId: string, peerId: string, muted: boolean): Promise<void> {
  await upsertConversation(userId, { peerId, muted });
}

export async function setDisappearingTimer(userId: string, peerId: string, seconds: number | null): Promise<void> {
  await upsertConversation(userId, { peerId, disappearingSeconds: seconds });
}

export async function setConversationTheme(userId: string, peerId: string, theme: ChatTheme): Promise<void> {
  await upsertConversation(userId, { peerId, theme });
}

// "Clear chat": wipes message history but keeps the conversation itself in
// the sidebar, unlike deleteConversation. Mirrors deleteMessage's "delete
// for me" scope -- this device's cache only.
export async function clearConversationMessages(userId: string, peerId: string): Promise<void> {
  await set(`conv:${peerId}`, [], messagesStore(userId));
  await upsertConversation(userId, { peerId, lastMessage: "", lastTimestamp: new Date().toISOString() });
}

export async function incrementUnread(userId: string, peerId: string): Promise<void> {
  const existing = await getConversations(userId);
  const current = existing.find((c) => c.peerId === peerId);
  await upsertConversation(userId, { peerId, unreadCount: (current?.unreadCount ?? 0) + 1 });
}

export async function clearUnread(userId: string, peerId: string): Promise<void> {
  await upsertConversation(userId, { peerId, unreadCount: 0 });
}

// Removes a 1:1 chat from the sidebar and wipes its local message history.
// Only ever affects this device -- there's no server-side conversation
// record to delete (see the module comment above), so the other person's
// copy of the chat is untouched.
export async function deleteConversation(userId: string, peerId: string): Promise<void> {
  const existing = await getConversations(userId);
  await set("conversations", existing.filter((c) => c.peerId !== peerId), metaStore(userId));
  await del(`conv:${peerId}`, messagesStore(userId));
}

export async function getContactUsername(userId: string, peerId: string): Promise<string | undefined> {
  const conversations = await getConversations(userId);
  return conversations.find((c) => c.peerId === peerId)?.peerUsername;
}

export async function getGroups(userId: string): Promise<LocalGroup[]> {
  return (await get<LocalGroup[]>("groups", metaStore(userId))) ?? [];
}

export async function upsertGroup(userId: string, patch: Partial<LocalGroup> & { groupId: string }): Promise<void> {
  const existing = await getGroups(userId);
  const current = existing.find((g) => g.groupId === patch.groupId);
  const merged: LocalGroup = {
    groupId: patch.groupId,
    name: patch.name ?? current?.name ?? "",
    avatarUrl: patch.avatarUrl ?? current?.avatarUrl ?? null,
    members: patch.members ?? current?.members ?? [],
    lastMessage: patch.lastMessage ?? current?.lastMessage ?? "",
    lastTimestamp: patch.lastTimestamp ?? current?.lastTimestamp ?? new Date().toISOString(),
    favourite: patch.favourite ?? current?.favourite ?? false,
    unreadCount: patch.unreadCount ?? current?.unreadCount ?? 0,
    muted: patch.muted ?? current?.muted ?? false,
    disappearingSeconds: "disappearingSeconds" in patch ? patch.disappearingSeconds : current?.disappearingSeconds ?? null,
    theme: patch.theme ?? current?.theme ?? "default",
    lists: patch.lists ?? current?.lists ?? [],
  };
  const others = existing.filter((g) => g.groupId !== patch.groupId);
  const updated = [merged, ...others].sort(
    (a, b) => new Date(b.lastTimestamp).getTime() - new Date(a.lastTimestamp).getTime()
  );
  await set("groups", updated, metaStore(userId));
}

export async function toggleGroupFavourite(userId: string, groupId: string): Promise<void> {
  const existing = await getGroups(userId);
  const current = existing.find((g) => g.groupId === groupId);
  if (!current) return;
  await upsertGroup(userId, { groupId, favourite: !current.favourite });
}

export async function setGroupMuted(userId: string, groupId: string, muted: boolean): Promise<void> {
  await upsertGroup(userId, { groupId, muted });
}

export async function setGroupDisappearingTimer(userId: string, groupId: string, seconds: number | null): Promise<void> {
  await upsertGroup(userId, { groupId, disappearingSeconds: seconds });
}

export async function setGroupTheme(userId: string, groupId: string, theme: ChatTheme): Promise<void> {
  await upsertGroup(userId, { groupId, theme });
}

// Same as clearConversationMessages, for a group thread.
export async function clearGroupMessages(userId: string, groupId: string): Promise<void> {
  await set(`conv:${groupThreadKey(groupId)}`, [], messagesStore(userId));
  await upsertGroup(userId, { groupId, lastMessage: "", lastTimestamp: new Date().toISOString() });
}

export async function incrementGroupUnread(userId: string, groupId: string): Promise<void> {
  const existing = await getGroups(userId);
  const current = existing.find((g) => g.groupId === groupId);
  await upsertGroup(userId, { groupId, unreadCount: (current?.unreadCount ?? 0) + 1 });
}

export async function clearGroupUnread(userId: string, groupId: string): Promise<void> {
  await upsertGroup(userId, { groupId, unreadCount: 0 });
}

// Same as deleteConversation, for a group thread -- removes it from this
// device's sidebar and history only; other members' copies are unaffected.
export async function deleteGroupThread(userId: string, groupId: string): Promise<void> {
  const existing = await getGroups(userId);
  await set("groups", existing.filter((g) => g.groupId !== groupId), metaStore(userId));
  await del(`conv:${groupThreadKey(groupId)}`, messagesStore(userId));
}

// "Add to list": custom labels (e.g. "Work", "Family") a user can create to
// organize their own sidebar -- purely local, like favourites, since it's
// just a personal view over conversations that already exist.
export async function getLists(userId: string): Promise<string[]> {
  return (await get<string[]>("lists", metaStore(userId))) ?? [];
}

export async function createList(userId: string, name: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) return;
  const existing = await getLists(userId);
  if (existing.some((l) => l.toLowerCase() === trimmed.toLowerCase())) return;
  await set("lists", [...existing, trimmed], metaStore(userId));
}

export async function deleteList(userId: string, name: string): Promise<void> {
  const existing = await getLists(userId);
  await set("lists", existing.filter((l) => l !== name), metaStore(userId));

  const conversations = await getConversations(userId);
  for (const c of conversations) {
    if (c.lists?.includes(name)) {
      await upsertConversation(userId, { peerId: c.peerId, lists: c.lists.filter((l) => l !== name) });
    }
  }
  const groups = await getGroups(userId);
  for (const g of groups) {
    if (g.lists?.includes(name)) {
      await upsertGroup(userId, { groupId: g.groupId, lists: g.lists.filter((l) => l !== name) });
    }
  }
}

export async function toggleConversationList(userId: string, peerId: string, listName: string): Promise<void> {
  const existing = await getConversations(userId);
  const current = existing.find((c) => c.peerId === peerId);
  if (!current) return;
  const lists = current.lists ?? [];
  const next = lists.includes(listName) ? lists.filter((l) => l !== listName) : [...lists, listName];
  await upsertConversation(userId, { peerId, lists: next });
}

export async function toggleGroupList(userId: string, groupId: string, listName: string): Promise<void> {
  const existing = await getGroups(userId);
  const current = existing.find((g) => g.groupId === groupId);
  if (!current) return;
  const lists = current.lists ?? [];
  const next = lists.includes(listName) ? lists.filter((l) => l !== listName) : [...lists, listName];
  await upsertGroup(userId, { groupId, lists: next });
}
