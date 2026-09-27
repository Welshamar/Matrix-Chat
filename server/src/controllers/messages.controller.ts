import { Request, Response } from "express";
import { prisma } from "../db/prisma";

interface ConversationPeer {
  peerId: string;
  peerUsername: string;
  peerAvatarUrl: string | null;
  lastMessageAt: string;
}

/**
 * GET /api/messages/inbox
 * Messages addressed to me that haven't been marked DELIVERED yet — lets a
 * client catch up after being offline. Still just relays opaque ciphertext.
 */
export async function fetchInbox(req: Request, res: Response): Promise<void> {
  const userId = req.userId!;

  const pending = await prisma.message.findMany({
    where: { recipientId: userId, status: "SENT" },
    orderBy: { timestamp: "asc" },
    take: 200,
  });

  res.json(
    pending
      .filter((m) => m.ciphertext !== null)
      .map((m) => ({
        id: m.id,
        senderId: m.senderId,
        ciphertext: m.ciphertext as string,
        signalMessageType: m.signalMessageType,
        viewOnce: m.viewOnce,
        kind: m.kind,
        groupId: m.groupId,
        timestamp: m.timestamp,
      }))
  );
}

/**
 * GET /api/messages/conversations
 *
 * A fresh install/reinstall/new device starts with an empty local
 * conversation list -- conversations are a purely client-side concept
 * (see localDb.ts's module comment), so there's normally no way to know
 * who to even show in the sidebar without the user re-searching each
 * username by hand. This reconstructs just the roster (who has this user
 * ever exchanged a 1:1 message with, and when most recently) from the
 * Message table's metadata, which persists indefinitely even after
 * ciphertext is nulled out on delivery -- never the message content
 * itself, which the server never retains regardless. Group membership is
 * already synced this way via GET /api/groups; this is the 1:1 equivalent.
 */
export async function listConversationPeers(req: Request, res: Response): Promise<void> {
  const userId = req.userId!;

  const messages = await prisma.message.findMany({
    where: {
      groupId: null,
      OR: [{ senderId: userId }, { recipientId: userId }],
    },
    select: { senderId: true, recipientId: true, timestamp: true },
    orderBy: { timestamp: "desc" },
    take: 2000, // Generous cap -- only the single most-recent row per peer matters.
  });

  const latestByPeer = new Map<string, Date>();
  for (const m of messages) {
    const peerId = m.senderId === userId ? m.recipientId : m.senderId;
    if (!latestByPeer.has(peerId)) latestByPeer.set(peerId, m.timestamp);
  }

  const peerIds = [...latestByPeer.keys()];
  const users = await prisma.user.findMany({
    where: { id: { in: peerIds } },
    select: { id: true, username: true, avatarUrl: true },
  });
  const userById = new Map(users.map((u) => [u.id, u]));

  const result: ConversationPeer[] = [];
  for (const peerId of peerIds) {
    const user = userById.get(peerId);
    if (!user) continue; // The other account was deleted since.
    result.push({
      peerId,
      peerUsername: user.username,
      peerAvatarUrl: user.avatarUrl,
      lastMessageAt: latestByPeer.get(peerId)!.toISOString(),
    });
  }

  res.json(result);
}
