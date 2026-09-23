# Matrix Chat

A real, working end-to-end encrypted chat app using the Signal Protocol
(X3DH key agreement + Double Ratchet), with a zero-knowledge relay server —
plus 1:1 groups, voice/video calls, and encrypted file transfer, all
running as a Next.js web app and as an Android app (Capacitor, pointed at
the same deployed web app).

## Features

- **1:1 and group messaging**, end-to-end encrypted (X3DH + Double Ratchet
  per member pair — see "Zero-knowledge guarantee" below), with typing
  indicators, delivery/read receipts, reply-to, delete-for-me, and
  view-once photos (server drops the ciphertext once viewed).
- **Voice notes**: hold-to-record, slide-to-cancel, drag-to-lock, waveform
  playback.
- **File attachments**: small files ride inline in the encrypted message;
  anything over 2MB (up to 100MB) is encrypted client-side in 1MiB
  AES-256-GCM chunks with a fresh random key and uploaded separately over
  HTTP — only a small pointer + key travels inside the Signal-encrypted
  message, so the server never sees plaintext either way. See
  `web/lib/attachments.ts` and `server/src/controllers/attachments.controller.ts`.
- **1:1 voice and video calls** (WebRTC, STUN/TURN — see `web/lib/webrtc.ts`),
  with mute, speaker toggle, camera on/off, switch camera, and
  Google-Meet-style floating emoji reactions. Calls survive a flaky
  connection: the signaling socket dropping doesn't end an in-progress call
  (media is peer-to-peer), an ICE restart runs automatically after a
  network change or drop, and outgoing video steps down (then pauses) under
  packet loss and recovers on its own. See `web/lib/callClient.ts`.
- **Push notifications** (Firebase Cloud Messaging) for the Android app
  when a message arrives while it has no live socket connection.
- **Android app**: a Capacitor 8 shell in *remote-URL mode* — it loads the
  deployed web app directly rather than bundling built assets, so any pure
  web/JS/CSS change ships live the moment it's deployed. Only native
  changes (a new Capacitor plugin, an `AndroidManifest.xml` permission)
  need a new APK build (`web/android/`).

## Structure

```
matrix-chat/
├── server/    Express + Socket.io + Prisma/Postgres relay (deploy to Render/Railway/Fly)
├── web/       Next.js chat UI + the Capacitor Android shell config (deploy to Vercel)
├── e2e/       Puppeteer regression suite — run by hand, see e2e/README.md
└── client/    Standalone reference package showing the Signal Protocol wrapper in isolation
```

`server/` and `web/` are the real app. `client/` is a smaller, framework-free
demonstration of the same crypto wrapper (`client/src/demo.ts`,
`client/src/live-e2e.ts`) kept for reference/testing — `web/lib/signal/`
has its own self-contained copy so the Vercel build doesn't depend on
anything outside `web/`.

## Why two hosts?

Socket.io needs a long-lived server process (persistent WebSocket
connections, in-memory presence). Vercel's serverless functions are
short-lived and stateless, so they aren't a fit for the realtime gateway.
The working split is:

- **`web/`** → Vercel (the public URL people actually visit; the Android
  app also points at this URL, in remote-URL mode)
- **`server/`** → Render/Railway/Fly (anything that keeps a Node process running)

## Zero-knowledge guarantee

The server only ever touches:
- **Public** key material (identity key, signed prekey + signature, one-time prekeys).
- **Opaque ciphertext blobs** (`Message.ciphertext`) it stores and relays byte-for-byte.
- **Opaque encrypted file bytes** (`Attachment`/`AttachmentChunk`) for heavy
  attachments — same story: stored and served byte-for-byte, with the
  AES key never leaving the sender's and recipient's Signal-encrypted
  message.
- **WebRTC signaling** (SDP offers/answers, ICE candidates) for calls — it
  relays these the same way, and never touches the call's actual audio/video,
  which flows directly between the two devices (or through a TURN relay) as
  DTLS-SRTP-encrypted media.

All private keys and Double Ratchet session state live in the browser's
IndexedDB (`web/lib/signal/IndexedDbStore.ts`) and never leave the device.
Verified live against a real Postgres database — see "Verification" below.

## Local development

**1. Backend**
```bash
cd server
cp .env.example .env   # set DATABASE_URL (Postgres/Neon) and JWT_SECRET
npm install
npx prisma db push     # sync schema — this project uses db push, not migrate,
                        # since it's solo/small-scale (see prisma/schema.prisma)
npm run dev             # http://localhost:4000
```
A cold Neon database can take several seconds to wake up, which is longer
than Prisma's default connection timeout — if a fresh `server/.env`
`DATABASE_URL` times out on the first request, append
`&connect_timeout=45&pool_timeout=45` to it.

**2. Frontend**
```bash
cd web
cp .env.local.example .env.local   # NEXT_PUBLIC_API_URL=http://localhost:4000
npm install
npm run dev             # http://localhost:3200
```

Open two browser profiles (or one normal + one private window — regular
tabs of the same profile share `localStorage`, so only one account can be
logged in per browser profile at a time, same as WhatsApp Web), register
two accounts, and start chatting.

**3. Regression tests (optional)** — see `e2e/README.md` for the full
Puppeteer suite (messaging, calls, video, file transfer, connection
resilience, voice notes, receipts, image fidelity).

**4. Android app (optional)** — `web/android/` is a Capacitor project in
remote-URL mode; see its `capacitor.config.ts` for the URL it loads and
`AndroidManifest.xml` for native permissions (camera, microphone, push).
Building it requires the Android SDK + a JDK; only needed when a native
change (a new permission, a new plugin) has been made — a pure web change
just needs `web/` redeployed.

## Deploying

### Backend → Render
`server/render.yaml` is a ready-to-use Blueprint. In the Render dashboard:
New → Blueprint → point at this repo → set `DATABASE_URL`, `JWT_SECRET`,
and `CORS_ORIGIN` (your Vercel URL) as environment variables. Root
directory is `server`. Free-tier Render spins the service down when idle,
so the first request after a while can take ~15-30s (cold start) — this is
normal, not a bug.

### Frontend → Vercel
Set the project's root directory to `web`, and add the environment
variable `NEXT_PUBLIC_API_URL` pointing at your deployed backend URL.
Redeploy after changing it (it's baked in at build time).

## Accounts & auth

Real password-based accounts: `POST /api/auth/register` / `POST
/api/auth/login` (bcrypt-hashed passwords, JWT bearer tokens, email
verification via a 6-digit code). On first login on a device, the client
generates a Signal identity key + prekeys locally and publishes only the
public halves via `POST /api/keys/prekey-bundle`. Because the schema
stores one identity key per **account** (not per device), logging into the
same account from a second device replaces the first device's published
keys — this is a deliberate MVP simplification (no multi-device linking),
consistent with the original single-identity-per-user schema.

A username is 3-32 characters and can be almost anything (any script's
letters, spaces, punctuation) — it's a display handle, not an identifier
used in a URL or filename, so the only things excluded are emoji and
control characters (see `web/lib/username.ts`, enforced server-side in
`auth.controller.ts`).

## REST API

- `POST /api/auth/register`, `POST /api/auth/verify-email`, `POST /api/auth/resend-code`, `POST /api/auth/login`
- `GET /api/auth/lookup/:username`, `GET /api/auth/resolve/:userId` — username ⇄ userId
- `PATCH /api/auth/profile` — display name, avatar, status text
- `POST /api/auth/push-token` — register an FCM token for push notifications
- `POST /api/keys/prekey-bundle`, `GET /api/keys/prekey-bundle/:userId`
- `GET /api/messages/inbox` — undelivered messages, for catch-up after being offline
- `POST /api/groups`, `GET /api/groups`, `GET /api/groups/:groupId`
- `POST /api/groups/:groupId/members`, `DELETE /api/groups/:groupId/members/:userId` (also self-leave), `PATCH /api/groups/:groupId/members/:userId` (role)
- `POST /api/attachments`, `PUT /api/attachments/:id/chunks/:index`, `POST /api/attachments/:id/complete`, `GET /api/attachments/:id`, `GET /api/attachments/:id/chunks/:index` — encrypted heavy-file transfer
- `GET /api/presence/:userId`, `POST /api/presence/batch` `{ userIds }` — a contact's online/last-seen state as of right now, for painting it in before the live socket event (below) has said anything

## Socket.IO gateway

Connect with `io(url, { auth: { token: jwt } })`.

**Messaging** (`server/src/sockets/signal.gateway.ts`):
- `signal:message` `{ recipientId | groupId, ciphertext, signalMessageType, kind, viewOnce? }` → relays verbatim, never inspected.
- `signal:receipt` `{ messageId, status: 'DELIVERED' | 'READ' }` → relayed back to the sender; drops the stored ciphertext once delivered.
- `signal:viewed` `{ messageId }` → a view-once message was shown; drops the ciphertext and tells the sender.
- `signal:typing` `{ recipientId | groupId, typing }` → composing-state presence, not persisted.
- `presence:visibility` `{ visible }` → whether this tab/app instance is in the foreground, for push-notification suppression.

**Calls** (`server/src/sockets/call.gateway.ts`) — pure WebRTC signaling relay, one-to-one only:
- `call:invite` / `call:answer` / `call:ice` / `call:reject` / `call:end`
- `call:mute`, `call:camera` — UI state so the other side can show a muted/camera-off indicator.
- `call:reaction` → floats an emoji reaction on the other side's call screen.
- `call:restart` / `call:restart-answer` / `call:restart-request` → ICE-restart renegotiation after a network change or a connection drop.

## Verification performed

- Full X3DH + Double Ratchet round trip run live in a real browser (not just unit-tested).
- Two independent accounts registered, messaged both directions, over a real
  Socket.io connection against a real Neon Postgres database.
- Queried the database directly mid-session and confirmed the stored rows
  contain only base64 ciphertext (or, for attachments, opaque encrypted
  bytes) — no plaintext anywhere.
- Confirmed message history and the Signal session survive a full page reload
  (IndexedDB persistence), and that offline messages are picked up via the
  inbox catch-up endpoint on next login.
- Two-browser Puppeteer regression suite (`e2e/`) covering messaging, group
  chat, voice/video calls, connection-loss recovery, and encrypted file
  transfer, run against the real dev stack (not mocked) — see `e2e/README.md`.

## Production hardening notes (not yet done)

- Multi-device support (currently one active device per account).
- Safety-number / identity-change UI warning (`saveIdentity()` in
  `IndexedDbStore.ts` already returns whether a contact's key changed —
  just needs a UI hook).
- Signed-prekey rotation and one-time-prekey replenishment when the pool runs low.
- Rate limiting on `/api/auth/*` and the socket gateway.
- Group calls (calls are 1:1 only — a group call would need an N-way mesh
  or an SFU, neither of which exists yet).
- The default TURN relay (`web/lib/webrtc.ts`) is Metered's free, shared,
  best-effort Open Relay project — fine for personal use, but a deployment
  expecting reliable calls at scale would want its own TURN credentials.
