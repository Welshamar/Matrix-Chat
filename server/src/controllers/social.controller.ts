import { Request, Response } from "express";
import { prisma } from "../db/prisma";

// Mirrors the client's own groupThreadKey() convention so one column on
// MutedThread covers both a 1:1 peer and a group with a single unique key.
function threadKeyFor(peerId?: string, groupId?: string): string | null {
  if (groupId) return `group:${groupId}`;
  if (peerId) return peerId;
  return null;
}

export async function blockUser(req: Request, res: Response): Promise<void> {
  const blockerId = req.userId!;
  const { userId: blockedId } = req.body as { userId?: string };
  if (!blockedId) {
    res.status(400).json({ error: "userId is required." });
    return;
  }
  if (blockedId === blockerId) {
    res.status(400).json({ error: "You can't block yourself." });
    return;
  }

  await prisma.block.upsert({
    where: { blockerId_blockedId: { blockerId, blockedId } },
    update: {},
    create: { blockerId, blockedId },
  });
  res.json({ ok: true });
}

export async function unblockUser(req: Request, res: Response): Promise<void> {
  const blockerId = req.userId!;
  const { userId: blockedId } = req.body as { userId?: string };
  if (!blockedId) {
    res.status(400).json({ error: "userId is required." });
    return;
  }

  await prisma.block.deleteMany({ where: { blockerId, blockedId } });
  res.json({ ok: true });
}

export async function getBlocks(req: Request, res: Response): Promise<void> {
  const blockerId = req.userId!;
  const blocks = await prisma.block.findMany({ where: { blockerId }, select: { blockedId: true } });
  res.json({ blockedUserIds: blocks.map((b) => b.blockedId) });
}

const MAX_REPORT_REASON_LENGTH = 1000;

export async function reportUser(req: Request, res: Response): Promise<void> {
  const reporterId = req.userId!;
  const { userId: reportedId, reason } = req.body as { userId?: string; reason?: string };
  if (!reportedId || !reason?.trim()) {
    res.status(400).json({ error: "userId and reason are required." });
    return;
  }
  if (reportedId === reporterId) {
    res.status(400).json({ error: "You can't report yourself." });
    return;
  }

  await prisma.report.create({
    data: { reporterId, reportedId, reason: reason.trim().slice(0, MAX_REPORT_REASON_LENGTH) },
  });
  res.json({ ok: true });
}

export async function muteThread(req: Request, res: Response): Promise<void> {
  const userId = req.userId!;
  const { peerId, groupId } = req.body as { peerId?: string; groupId?: string };
  const threadKey = threadKeyFor(peerId, groupId);
  if (!threadKey) {
    res.status(400).json({ error: "peerId or groupId is required." });
    return;
  }

  await prisma.mutedThread.upsert({
    where: { userId_threadKey: { userId, threadKey } },
    update: {},
    create: { userId, threadKey },
  });
  res.json({ ok: true });
}

export async function unmuteThread(req: Request, res: Response): Promise<void> {
  const userId = req.userId!;
  const { peerId, groupId } = req.body as { peerId?: string; groupId?: string };
  const threadKey = threadKeyFor(peerId, groupId);
  if (!threadKey) {
    res.status(400).json({ error: "peerId or groupId is required." });
    return;
  }

  await prisma.mutedThread.deleteMany({ where: { userId, threadKey } });
  res.json({ ok: true });
}

export async function getMutes(req: Request, res: Response): Promise<void> {
  const userId = req.userId!;
  const mutes = await prisma.mutedThread.findMany({ where: { userId }, select: { threadKey: true } });
  res.json({ threadKeys: mutes.map((m) => m.threadKey) });
}
