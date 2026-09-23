# End-to-end tests

Puppeteer scripts that drive two real, isolated browser profiles ("alice"
and "bob") against a running `server/` + `web/` dev stack, over a real
Socket.IO connection and a real database. There is no mocking of the
Signal Protocol, WebRTC, or the network — these are the same checks used
throughout development to confirm a change actually works, not just that
it compiles.

They are **not** run in CI (no CI is configured for this project) and are
**not** built/shipped with the app — run them by hand before/after a change
that touches messaging, calls, voice notes, or file transfer.

## One-time setup

```bash
cd e2e
npm install
```

You also need a local Chrome/Chromium install (the tests launch it
directly via `puppeteer-core`, which has no bundled browser).

## Running against your local stack

1. Start the backend and frontend dev servers (see the root `README.md`).
2. Create the two QA accounts the tests log in as — **run this from the
   repo root, with the same `DATABASE_URL` your local `server/` uses**:
   ```bash
   node e2e/qa-users.js create
   ```
3. Run whichever suite(s) you need:
   ```bash
   cd e2e
   npm run test:app                 # general regression
   npm run test:calls               # voice call lifecycle
   npm run test:call-ui             # call screen UI states
   npm run test:video               # video calls + reactions
   npm run test:camera-permission   # camera/mic permission handling
   npm run test:resilience          # calls surviving a bad connection
   npm run test:files               # heavy encrypted file transfer
   npm run test:files-download      # byte-exact download check
   npm run test:player              # voice-note player UI
   npm run test:receipts            # delivery/read ticks
   npm run test:fidelity            # image/file sent at original quality
   npm run test:presence            # username rules + online/offline presence
   npm run test:all                 # everything, in sequence
   ```
   Each script prints `PASS`/`FAIL` per check and exits non-zero on any
   failure. Screenshots (`*.png`) land next to the script that took them —
   useful for a quick visual sanity check, not checked into git.
4. **Delete the QA accounts again afterwards** — `server/.env` points at
   the real shared database, and these tests write real rows to it:
   ```bash
   node e2e/qa-users.js delete
   ```

### Against a deployed stack instead of localhost

```bash
E2E_BASE_URL=https://your-app.vercel.app npm run test:app
```
(The web app's `NEXT_PUBLIC_API_URL` build-time env var controls which
backend it talks to — point that at the deployed server before building,
same as any other deploy.)

### Non-default Chrome path

```bash
E2E_CHROME_PATH="/usr/bin/chromium" npm run test:app
```

## What each script covers

| Script | Covers |
| --- | --- |
| `app-test.js` | Login, unread badges, read receipts, typing indicators, voice-note recording (hold-release / lock / pause / cancel), file-card send/receive, reply, delete-for-me, chat list staying usable when the network is down. |
| `call-test.js` | 1:1 voice call: delayed accept, immediate accept, decline, mute, hang-up from either side. |
| `call-ui-test.js` | WhatsApp-style call screen: ringing, incoming, connected, minimized, peer-muted (with screenshots). |
| `video-test.js` | 1:1 video calls: camera on/off, switch camera, a callee with no camera, controls auto-hiding, Google-Meet-style emoji reactions (incl. confetti), reactions in a voice call too. |
| `camera-permission-test.js` | A camera/mic permission prompt left unanswered, and every `getUserMedia` failure mode (blocked, no device, device busy), with the right message for web vs. the Android app. |
| `resilience-test.js` | Calls staying up through a 14s signaling-socket outage, ICE restart after a network change, a brief connection blip healing itself, a genuine drop showing "Reconnecting…", and video automatically stepping down/pausing/recovering under simulated packet loss. |
| `files-test.js` | Heavy encrypted file transfer end-to-end: small files staying inline, a large photo auto-downloading byte-exact, retrying a failed chunk, rejecting a tampered chunk, an expired file, cancelling mid-upload, and the size limit. |
| `files-download-test.js` | Focused byte-exact check: a non-image heavy file downloads, decrypts, and is saved as the exact original bytes; re-saving reuses the local copy instead of re-downloading. |
| `player-test.js` | Voice-note player UI (waveform, scrubbing, play/pause). |
| `receipt-test.js` | Message ticks move through sent → delivered → read correctly on both sides. |
| `fidelity-test.js` | A sent image/file is never recompressed — pixel-exact against the original (compared with `sharp`). |
| `presence-username-test.js` | Registration accepts spaces and non-Latin/punctuation characters in a username but rejects emoji and too-short ones; a contact's online/offline status (and "last seen ...") updates live in the chat header, its avatar dot, and the sidebar row. |
| `qa-users.js` | Not a test — creates/deletes the two QA accounts (`e2e_alice`, `e2e_bob`, password `TestPass123!`) the other scripts log in as. |

## Notes for writing new ones

- Each script is self-contained (its own `newUser`/login helper, its own
  `check()`/`PASS`/`FAIL` reporting, exits 1 on any failure) — copy the
  shape of an existing one rather than introducing a shared harness.
- Use two isolated `browser.createBrowserContext()` profiles per test, not
  two tabs in one context — tabs in the same context share `localStorage`,
  so only one account can be logged in at a time (same constraint as real
  browser tabs; see the root README).
- `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream` gives
  every profile a synthetic camera/mic with no permission prompts — needed
  for any call/voice-note test. Video tests can also inject fake stats
  (see `resilience-test.js`) to simulate a bad connection.
- The local Neon database can have a multi-second cold start; local runs
  against it export `DATABASE_URL` with `&connect_timeout=45&pool_timeout=45`
  appended (see the root README's testing notes) rather than raising
  Prisma's default 5s timeout in production code.
- Presence/online-status tests are sensitive to *any* other live session
  logged in as a QA account — including a browser window opened by hand
  (or by an assistant) outside Puppeteer entirely, which keeps a real socket
  connected that these tests have no way to see or close. If a presence
  check reports someone online when nothing you started should be, that's
  usually why — close anything else signed in as `e2e_alice`/`e2e_bob`
  first, don't assume it's the feature.
