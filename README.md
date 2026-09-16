# Matrix Chat

A real, working end-to-end encrypted chat app using the Signal Protocol
(X3DH key agreement + Double Ratchet), with a zero-knowledge relay server.

## Structure

```
matrix-chat/
├── server/    Express + Socket.io + Prisma/Postgres relay (deploy to Render/Railway/Fly)
├── web/       Next.js chat UI — the public app (deploy to Vercel)
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

- **`web/`** → Vercel (the public URL people actually visit)
- **`server/`** → Render/Railway/Fly (anything that keeps a Node process running)

## Zero-knowledge guarantee

The server only ever touches:
- **Public** key material (identity key, signed prekey + signature, one-time prekeys).
- **Opaque ciphertext blobs** (`Message.ciphertext`) it stores and relays byte-for-byte.

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

## Deploying

### Backend → Render
`server/render.yaml` is a ready-to-use Blueprint. In the Render dashboard:
New → Blueprint → point at this repo → set `DATABASE_URL`, `JWT_SECRET`,
and `CORS_ORIGIN` (your Vercel URL) as environment variables. Root
directory is `server`.

### Frontend → Vercel
Set the project's root directory to `web`, and add the environment
variable `NEXT_PUBLIC_API_URL` pointing at your deployed backend URL.
Redeploy after changing it (it's baked in at build time).

## Accounts & auth

Real password-based accounts: `POST /api/auth/register` / `POST
/api/auth/login` (bcrypt-hashed passwords, JWT bearer tokens). On first
login on a device, the client generates a Signal identity key + prekeys
locally and publishes only the public halves via
`POST /api/keys/prekey-bundle`. Because the schema stores one identity key
per **account** (not per device), logging into the same account from a
second device replaces the first device's published keys — this is a
deliberate MVP simplification (no multi-device linking), consistent with
the original single-identity-per-user schema.

## REST API

- `POST /api/auth/register`, `POST /api/auth/login`
- `GET /api/auth/lookup/:username`, `GET /api/auth/resolve/:userId` — username ⇄ userId
- `POST /api/keys/prekey-bundle`, `GET /api/keys/prekey-bundle/:userId`
- `GET /api/messages/inbox` — undelivered messages, for catch-up after being offline

## Socket.IO gateway

Connect with `io(url, { auth: { token: jwt } })`.
- `signal:message` `{ recipientId, ciphertext, signalMessageType }` → relays verbatim, never inspected.
- `signal:receipt` `{ messageId, status: 'DELIVERED' | 'READ' }` → relayed back to the sender.

## Verification performed

- Full X3DH + Double Ratchet round trip run live in a real browser (not just unit-tested).
- Two independent accounts registered, messaged both directions, over a real
  Socket.io connection against a real Neon Postgres database.
- Queried the database directly mid-session and confirmed the stored rows
  contain only base64 ciphertext — no plaintext anywhere.
- Confirmed message history and the Signal session survive a full page reload
  (IndexedDB persistence), and that offline messages are picked up via the
  inbox catch-up endpoint on next login.

## Production hardening notes (not yet done)

- Multi-device support (currently one active device per account).
- Safety-number / identity-change UI warning (`saveIdentity()` in
  `IndexedDbStore.ts` already returns whether a contact's key changed —
  just needs a UI hook).
- Signed-prekey rotation and one-time-prekey replenishment when the pool runs low.
- Rate limiting on `/api/auth/*` and the socket gateway.
