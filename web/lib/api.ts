const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export interface AuthResponse {
  userId: string;
  username: string;
  token: string;
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

export function register(username: string, password: string): Promise<AuthResponse> {
  return publicRequest("/api/auth/register", { method: "POST", body: JSON.stringify({ username, password }) });
}

export function login(username: string, password: string): Promise<AuthResponse> {
  return publicRequest("/api/auth/login", { method: "POST", body: JSON.stringify({ username, password }) });
}

export function lookupUsername(token: string, username: string): Promise<{ userId: string; username: string }> {
  return authedRequest(`/api/auth/lookup/${encodeURIComponent(username)}`, token, { method: "GET" });
}

export function resolveUserId(token: string, userId: string): Promise<{ userId: string; username: string }> {
  return authedRequest(`/api/auth/resolve/${encodeURIComponent(userId)}`, token, { method: "GET" });
}

export interface InboxEnvelope {
  id: string;
  senderId: string;
  ciphertext: string;
  signalMessageType: number;
  timestamp: string;
}

export function fetchInbox(token: string): Promise<InboxEnvelope[]> {
  return authedRequest("/api/messages/inbox", token, { method: "GET" });
}

export { API_URL };
