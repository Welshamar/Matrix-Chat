import { Request, Response } from "express";
import { prisma } from "../db/prisma";
import { isUserOnline } from "../sockets/signal.gateway";

const MAX_BATCH_USER_IDS = 200;

interface PresenceInfo {
  online: boolean;
  lastSeenAt: string | null;
}

/** GET /api/presence/:userId — current online state, for opening a chat
 *  (the live socket broadcast only covers changes from here on; this fills
 *  in whatever the state already was before this client connected). */
export async function getPresence(req: Request, res: Response): Promise<void> {
  const { userId } = req.params;
  const online = isUserOnline(userId);
  let lastSeenAt: string | null = null;
  if (!online) {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { lastSeenAt: true } });
    lastSeenAt = user?.lastSeenAt?.toISOString() ?? null;
  }
  res.json({ online, lastSeenAt } satisfies PresenceInfo);
}

/** POST /api/presence/batch  { userIds: string[] }  ->  { [userId]: PresenceInfo }
 *  Used to paint the conversation list in one round trip rather than one
 *  request per row. */
export async function getPresenceBatch(req: Request, res: Response): Promise<void> {
  const { userIds } = (req.body ?? {}) as { userIds?: unknown };
  if (!Array.isArray(userIds) || userIds.some((id) => typeof id !== "string")) {
    res.status(400).json({ error: "userIds must be an array of strings." });
    return;
  }
  const ids = [...new Set(userIds as string[])].slice(0, MAX_BATCH_USER_IDS);

  const offlineIds = ids.filter((id) => !isUserOnline(id));
  const lastSeenRows = offlineIds.length
    ? await prisma.user.findMany({ where: { id: { in: offlineIds } }, select: { id: true, lastSeenAt: true } })
    : [];
  const lastSeenById = new Map(lastSeenRows.map((r) => [r.id, r.lastSeenAt?.toISOString() ?? null]));

  const result: Record<string, PresenceInfo> = {};
  for (const id of ids) {
    const online = isUserOnline(id);
    result[id] = { online, lastSeenAt: online ? null : lastSeenById.get(id) ?? null };
  }
  res.json(result);
}
