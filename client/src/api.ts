export interface UploadBundlePayload {
  registrationId: number;
  identityKey: string;
  signedPreKey: { keyId: number; publicKey: string; signature: string };
  oneTimePreKeys: Array<{ keyId: number; publicKey: string }>;
}

export interface PreKeyBundleResponse {
  userId: string;
  registrationId: number;
  identityKey: string;
  signedPreKey: { keyId: number; publicKey: string; signature: string };
  preKey: { keyId: number; publicKey: string } | null;
}

async function request<T>(baseUrl: string, path: string, token: string, init?: RequestInit): Promise<T> {
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

/** POST /api/keys/prekey-bundle — publish this device's public key material. */
export function uploadPreKeyBundle(
  baseUrl: string,
  token: string,
  payload: UploadBundlePayload
): Promise<void> {
  return request(baseUrl, "/api/keys/prekey-bundle", token, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

/** GET /api/keys/prekey-bundle/:userId — fetch a recipient's bundle to start X3DH. */
export function fetchPreKeyBundle(
  baseUrl: string,
  token: string,
  userId: string
): Promise<PreKeyBundleResponse> {
  return request(baseUrl, `/api/keys/prekey-bundle/${userId}`, token, { method: "GET" });
}
