import http from "http";
import { Server } from "socket.io";
import { createApp } from "./app";
import { registerSignalGateway } from "./sockets/signal.gateway";
import { registerCallGateway } from "./sockets/call.gateway";
import { env } from "./config/env";
import { purgeExpiredAttachments } from "./controllers/attachments.controller";

// Last-resort net: every request/socket path already catches its own
// errors, but this stops anything that slips through from taking the
// whole relay down (Node terminates on unhandled rejections by default).
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
});

const app = createApp();
const httpServer = http.createServer(app);

const io = new Server(httpServer, {
  cors: { origin: env.CORS_ORIGIN },
  // Small files (<= FileAttachButton's INLINE_MAX_BYTES) and voice notes still
  // ride inside the message as base64 twice over (~1.8x), so one frame can be a
  // few MB; the default 1MB is too tight. Heavy files don't come through here
  // any more -- they go over HTTP as encrypted chunks (see attachments routes).
  // The ceiling stays high only so an older, already-open client that still
  // sends big files inline keeps working until it reloads.
  maxHttpBufferSize: 40 * 1024 * 1024,
  // Socket.io's defaults (25s ping interval, 20s timeout) mean a killed app
  // can look "still connected" to the server for up to ~45s after it's
  // actually gone -- long enough that a message sent in that window skips
  // the push notification (see isUserVisible in signal.gateway.ts) because
  // the server thinks a live socket will deliver it. Tightened so a dead
  // connection is detected in ~30s instead. The timeout can't be much shorter:
  // while a multi-MB frame (a voice note, a photo) is still uploading, the
  // client's pong queues behind it, and an 8s window used to close the socket
  // mid-send on a slow uplink -- the message then never got acknowledged.
  pingInterval: 10_000,
  pingTimeout: 20_000,
});

registerSignalGateway(io);
registerCallGateway(io);

// Expire stored file chunks (and abandoned half-uploads) hourly and once on boot.
const purge = () => purgeExpiredAttachments().catch((err) => console.error("Attachment purge failed:", err));
setTimeout(purge, 30_000);
setInterval(purge, 60 * 60 * 1000).unref();

httpServer.listen(env.PORT, () => {
  console.log(`Matrix Chat signal relay listening on :${env.PORT}`);
});
