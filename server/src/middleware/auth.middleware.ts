import { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

interface TokenPayload {
  sub: string;
}

/** Express middleware: requires a valid `Authorization: Bearer <jwt>` header, sets req.userId. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;

  if (!token) {
    res.status(401).json({ error: "Missing bearer token." });
    return;
  }

  try {
    const payload = jwt.verify(token, env.JWT_SECRET) as TokenPayload;
    req.userId = payload.sub;
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token." });
  }
}

/** Verifies a Socket.IO handshake token and returns the authenticated userId. */
export function verifySocketToken(token: string | undefined): string {
  if (!token) throw new Error("Missing token.");
  const payload = jwt.verify(token, env.JWT_SECRET) as TokenPayload;
  return payload.sub;
}
