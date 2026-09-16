import http from "http";
import { Server } from "socket.io";
import { createApp } from "./app";
import { registerSignalGateway } from "./sockets/signal.gateway";
import { env } from "./config/env";

const app = createApp();
const httpServer = http.createServer(app);

const io = new Server(httpServer, {
  cors: { origin: env.CORS_ORIGIN },
});

registerSignalGateway(io);

httpServer.listen(env.PORT, () => {
  console.log(`Matrix Chat signal relay listening on :${env.PORT}`);
});
