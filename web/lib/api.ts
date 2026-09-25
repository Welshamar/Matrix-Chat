const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export interface AuthResponse {
  userId: string;
  username: string;
  avatarUrl: string | null;
  statusText: string | null;
  token: string;
}

export interface UserProfile {
  userId: string;
  username: string;
  avatarUrl: string | null;
  statusText: string | null;
}

async function publicRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Request to ${path} failed with status ${res.status}`);
  }
  return res.json() as Promise<T>;
}

async function authedRequest<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  return publicRequest<T>(path, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...init?.headers },
  });
}

export interface RegisterPendingResponse {
  username: string;
  email: string;
  message: string;
}

export function register(username: string, email: string, password: string): Promise<RegisterPendingResponse> {
  return publicRequest("/api/auth/register", { method: "POST", body: JSON.stringify({ username, email, password }) });
}

// Thrown by login() specifically for the "needs verification" case, so the
// UI can route to the code-entry step instead of showing a generic error.
export class EmailNotVerifiedError extends Error {
  constructor(public username: string) {
    super("Email not verified.");
    this.name = "EmailNotVerifiedError";
  }
}

export async function login(username: string, password: string): Promise<AuthResponse> {
  try {
    return await publicRequest<AuthResponse>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
  } catch (err) {
    if (err instanceof Error && err.message === "Email not verified.") {
      throw new EmailNotVerifiedError(username);
    }
    throw err;
  }
}

export function verifyEmail(username: string, code: string): Promise<AuthResponse> {
  return publicRequest("/api/auth/verify-email", { method: "POST", body: JSON.stringify({ username, code }) });
}

export function resendCode(username: string): Promise<{ message: string }> {
  return publicRequest("/api/auth/resend-code", { method: "POST", body: JSON.stringify({ username }) });
}

export function forgotPassword(username: string, email: string): Promise<{ username: string; message: string }> {
  return publicRequest("/api/auth/forgot-password", { method: "POST", body: JSON.stringify({ username, email }) });
}

export function resetPassword(username: string, code: string, newPassword: string): Promise<AuthResponse> {
  return publicRequest("/api/auth/reset-password", {
    method: "POST",
    body: JSON.stringify({ username, code, newPassword }),
  });
}

// Permanent, no undo -- see deleteAccount in auth.controller.ts.
export function deleteAccount(token: string, password: string): Promise<{ ok: true }> {
  return authedRequest("/api/auth/account", token, { method: "DELETE", body: JSON.stringify({ password }) });
}

export function lookupUsername(token: string, username: string): Promise<UserProfile> {
  return authedRequest(`/api/auth/lookup/${encodeURIComponent(username)}`, token, { method: "GET" });
}

export function resolveUserId(token: string, userId: string): Promise<UserProfile> {
  return authedRequest(`/api/auth/resolve/${encodeURIComponent(userId)}`, token, { method: "GET" });
}

export function updateProfile(
  token: string,
  patch: { avatarUrl?: string | null; statusText?: string | null }
): Promise<UserProfile> {
  return authedRequest("/api/auth/profile", token, { method: "PATCH", body: JSON.stringify(patch) });
}

// Registers this device's FCM token so the server can push a notification
// when a message arrives while the app has no live socket connection (see
// call.gateway.ts's isUserOnline check, reused the same way here).
export function registerPushToken(token: string, fcmToken: string): Promise<{ ok: true }> {
  return authedRequest("/api/auth/push-token", token, { method: "POST", body: JSON.stringify({ fcmToken }) });
}

export interface InboxEnvelope {
  id: string;
  senderId: string;
  ciphertext: string;
  signalMessageType: number;
  viewOnce: boolean;
  kind: "TEXT" | "VOICE" | "FILE";
  groupId: string | null;
  timestamp: string;
}

export function fetchInbox(token: string): Promise<InboxEnvelope[]> {
  return authedRequest("/api/messages/inbox", token, { method: "GET" });
}

export type GroupRole = "ADMIN" | "MEMBER";

export interface GroupMemberDTO {
  userId: string;
  username: string;
  avatarUrl: string | null;
  role: GroupRole;
}

export interface GroupDTO {
  groupId: string;
  name: string;
  avatarUrl: string | null;
  members: GroupMemberDTO[];
}

export function createGroup(token: string, name: string, memberUserIds: string[]): Promise<GroupDTO> {
  return authedRequest("/api/groups", token, { method: "POST", body: JSON.stringify({ name, memberUserIds }) });
}

export function listGroups(token: string): Promise<GroupDTO[]> {
  return authedRequest("/api/groups", token, { method: "GET" });
}

export function getGroup(token: string, groupId: string): Promise<GroupDTO> {
  return authedRequest(`/api/groups/${groupId}`, token, { method: "GET" });
}

export function addGroupMember(token: string, groupId: string, userId: string): Promise<GroupDTO> {
  return authedRequest(`/api/groups/${groupId}/members`, token, { method: "POST", body: JSON.stringify({ userId }) });
}

export function removeGroupMember(token: string, groupId: string, userId: string): Promise<void> {
  return authedRequest(`/api/groups/${groupId}/members/${userId}`, token, { method: "DELETE" });
}

export function updateGroupMemberRole(token: string, groupId: string, userId: string, role: GroupRole): Promise<void> {
  return authedRequest(`/api/groups/${groupId}/members/${userId}`, token, {
    method: "PATCH",
    body: JSON.stringify({ role }),
  });
}

export interface PresenceInfo {
  online: boolean;
  lastSeenAt: string | null;
}

// Fills in state from before this client connected -- the live
// "presence:update" socket event (see lib/socket.ts) only covers changes
// from here on.
export function fetchPresence(token: string, userId: string): Promise<PresenceInfo> {
  return authedRequest(`/api/presence/${encodeURIComponent(userId)}`, token, { method: "GET" });
}

export function fetchPresenceBatch(token: string, userIds: string[]): Promise<Record<string, PresenceInfo>> {
  if (userIds.length === 0) return Promise.resolve({});
  return authedRequest("/api/presence/batch", token, { method: "POST", body: JSON.stringify({ userIds }) });
}

// Blocking, reporting and muting all need at least a thin server round trip
// (see server/src/controllers/social.controller.ts): a block/mute has to be
// enforced by the server itself (dropping messages/calls, skipping a push)
// since it can still reach this device via a live socket or a background
// push regardless of anything purely local.
export function blockUser(token: string, userId: string): Promise<{ ok: true }> {
  return authedRequest("/api/social/block", token, { method: "POST", body: JSON.stringify({ userId }) });
}

export function unblockUser(token: string, userId: string): Promise<{ ok: true }> {
  return authedRequest("/api/social/unblock", token, { method: "POST", body: JSON.stringify({ userId }) });
}

export function fetchBlockedUserIds(token: string): Promise<{ blockedUserIds: string[] }> {
  return authedRequest("/api/social/blocks", token, { method: "GET" });
}

export function reportUser(token: string, userId: string, reason: string): Promise<{ ok: true }> {
  return authedRequest("/api/social/report", token, { method: "POST", body: JSON.stringify({ userId, reason }) });
}

export function muteThread(token: string, target: { peerId?: string; groupId?: string }): Promise<{ ok: true }> {
  return authedRequest("/api/social/mute", token, { method: "POST", body: JSON.stringify(target) });
}

export function unmuteThread(token: string, target: { peerId?: string; groupId?: string }): Promise<{ ok: true }> {
  return authedRequest("/api/social/unmute", token, { method: "POST", body: JSON.stringify(target) });
}

export function fetchMutedThreadKeys(token: string): Promise<{ threadKeys: string[] }> {
  return authedRequest("/api/social/mutes", token, { method: "GET" });
}

export { API_URL };
