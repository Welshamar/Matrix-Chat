import http from "http";
import { Server } from "socket.io";
import { createApp } from "./app";
import { registerSignalGateway } from "./sockets/signal.gateway";
import { registerCallGateway } from "./sockets/call.gateway";
import { env } from "./config/env";

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
  // A file goes out as base64 inside the message envelope, then the whole
  // envelope is encrypted and base64'd again, so one frame is ~1.8x the file
  // (16MB file -> ~29MB). Sized for FileAttachButton's MAX_FILE_BYTES; the
  // default 1MB is far too tight.
  maxHttpBufferSize: 40 * 1024 * 1024,
  // Socket.io's defaults (25s ping interval, 20s timeout) mean a killed app
  // can look "still connected" to the server for up to ~45s after it's
  // actually gone -- long enough that a message sent in that window skips
  // the push notification (see isUserVisible in signal.gateway.ts) because
  // the server thinks a live socket will deliver it. Tightened so a dead
  // connection is detected in ~18s instead.
  pingInterval: 10_000,
  pingTimeout: 8_000,
});

registerSignalGateway(io);
registerCallGateway(io);

httpServer.listen(env.PORT, () => {
  console.log(`Matrix Chat signal relay listening on :${env.PORT}`);
});
