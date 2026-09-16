import express, { Express } from "express";
import cors from "cors";
import { env } from "./config/env";
import keysRouter from "./routes/keys.routes";
import authRouter from "./routes/auth.routes";
import messagesRouter from "./routes/messages.routes";

export function createApp(): Express {
  const app = express();

  app.use(cors({ origin: env.CORS_ORIGIN }));
  app.use(express.json({ limit: "600kb" })); // headroom for base64 avatar uploads (capped at ~400KB)

  app.get("/health", (_req, res) => res.json({ status: "ok" }));

  app.use("/api/auth", authRouter);
  app.use("/api/keys", keysRouter);
  app.use("/api/messages", messagesRouter);

  return app;
}
