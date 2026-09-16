import http from "http";
import { Server } from "socket.io";
import { createApp } from "./app";
import { registerSignalGateway } from "./sockets/signal.gateway";
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
});

registerSignalGateway(io);

httpServer.listen(env.PORT, () => {
  console.log(`Matrix Chat signal relay listening on :${env.PORT}`);
});
