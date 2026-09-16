import { Request, Response } from "express";
import { prisma } from "../db/prisma";

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
    pending.map((m) => ({
      id: m.id,
      senderId: m.senderId,
      ciphertext: m.ciphertext,
      signalMessageType: m.signalMessageType,
      timestamp: m.timestamp,
    }))
  );
}
