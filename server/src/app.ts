import express, { Express, NextFunction, Request, Response } from "express";
import cors from "cors";
import { env } from "./config/env";
import keysRouter from "./routes/keys.routes";
import authRouter from "./routes/auth.routes";
import messagesRouter from "./routes/messages.routes";
import groupsRouter from "./routes/groups.routes";

export function createApp(): Express {
  const app = express();

  app.use(cors({ origin: env.CORS_ORIGIN }));
  app.use(express.json({ limit: "600kb" })); // headroom for base64 avatar uploads (capped at ~400KB)

  app.get("/health", (_req, res) => res.json({ status: "ok" }));

  app.use("/api/auth", authRouter);
  app.use("/api/keys", keysRouter);
  app.use("/api/messages", messagesRouter);
  app.use("/api/groups", groupsRouter);

  // Catches anything asyncHandler forwards (e.g. Prisma losing the DB
  // connection) so a transient failure returns a normal error response
  // instead of crashing the process via an unhandled rejection.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error("Unhandled request error:", err);
    if (res.headersSent) return;
    res.status(503).json({ error: "Service temporarily unavailable. Please try again." });
  });

  return app;
}
