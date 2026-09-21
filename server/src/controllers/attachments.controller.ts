import { Request, Response } from "express";
import { prisma } from "../db/prisma";

// Large files bypass the realtime socket (one giant frame starves the
// ping/pong keepalive and gets the connection dropped mid-transfer). They are
// uploaded here in small chunks instead -- already encrypted by the sender, so
// this is an opaque byte store, the same zero-knowledge stance as the message
// relay -- and fetched back the same way. See web/lib/attachments.ts.

// 1 MiB of file + AES-GCM's IV (12 B) and tag (16 B) per chunk, with headroom.
export const MAX_CHUNK_BYTES = 1024 * 1024 + 64;
// A 100 MB file is 100 chunks; leave room for the per-chunk overhead.
export const MAX_ATTACHMENT_BYTES = 105 * 1024 * 1024;
export const MAX_ATTACHMENT_CHUNKS = 128;
// Neon's free tier is small; cap what any one person can have sitting on the
// server at once, and expire everything after the retention window.
export const MAX_OWNER_STORED_BYTES = 300 * 1024 * 1024;
export const ATTACHMENT_TTL_MS = 14 * 24 * 60 * 60 * 1000;
// An upload that never completed is abandoned after this long.
export const ABANDONED_UPLOAD_MS = 60 * 60 * 1000;

function isPositiveInt(n: unknown, max: number): n is number {
  return typeof n === "number" && Number.isInteger(n) && n > 0 && n <= max;
}

/** POST /api/attachments  { chunks, size }  ->  { id } */
export async function createAttachment(req: Request, res: Response): Promise<void> {
  const userId = req.userId!;
  const { chunks, size } = (req.body ?? {}) as { chunks?: unknown; size?: unknown };

  if (!isPositiveInt(chunks, MAX_ATTACHMENT_CHUNKS) || !isPositiveInt(size, MAX_ATTACHMENT_BYTES)) {
    res.status(400).json({ error: "That file is too large to send (limit is 100 MB)." });
    return;
  }

  const stored = await prisma.attachment.aggregate({
    where: { ownerId: userId, createdAt: { gt: new Date(Date.now() - ATTACHMENT_TTL_MS) } },
    _sum: { size: true },
  });
  if ((stored._sum.size ?? 0) + size > MAX_OWNER_STORED_BYTES) {
    res.status(413).json({ error: "Your file storage is full right now. Older files clear out automatically after 14 days." });
    return;
  }

  const attachment = await prisma.attachment.create({ data: { ownerId: userId, totalChunks: chunks, size } });
  res.status(201).json({ id: attachment.id });
}

/** PUT /api/attachments/:id/chunks/:index  (raw bytes) */
export async function putChunk(req: Request, res: Response): Promise<void> {
  const userId = req.userId!;
  const { id } = req.params;
  const index = Number(req.params.index);
  const body = req.body as unknown;

  if (!Buffer.isBuffer(body) || body.length === 0 || body.length > MAX_CHUNK_BYTES) {
    res.status(400).json({ error: "Invalid chunk." });
    return;
  }

  const attachment = await prisma.attachment.findUnique({ where: { id } });
  if (!attachment || attachment.ownerId !== userId) {
    res.status(404).json({ error: "Upload not found." });
    return;
  }
  if (attachment.complete) {
    res.status(409).json({ error: "Upload already finished." });
    return;
  }
  if (!Number.isInteger(index) || index < 0 || index >= attachment.totalChunks) {
    res.status(400).json({ error: "Chunk index out of range." });
    return;
  }

  // Upsert so a retried chunk (the client retries on flaky connections) is
  // idempotent instead of failing on the primary key.
  await prisma.attachmentChunk.upsert({
    where: { attachmentId_index: { attachmentId: id, index } },
    create: { attachmentId: id, index, length: body.length, data: body },
    update: { length: body.length, data: body },
  });
  res.status(204).end();
}

/** POST /api/attachments/:id/complete */
export async function completeAttachment(req: Request, res: Response): Promise<void> {
  const userId = req.userId!;
  const { id } = req.params;

  const attachment = await prisma.attachment.findUnique({ where: { id } });
  if (!attachment || attachment.ownerId !== userId) {
    res.status(404).json({ error: "Upload not found." });
    return;
  }

  const received = await prisma.attachmentChunk.aggregate({
    where: { attachmentId: id },
    _count: { _all: true },
    _sum: { length: true },
  });
  if (received._count._all !== attachment.totalChunks) {
    res.status(409).json({ error: `Upload incomplete (${received._count._all}/${attachment.totalChunks} chunks).` });
    return;
  }

  await prisma.attachment.update({ where: { id }, data: { complete: true, size: received._sum.length ?? attachment.size } });
  res.status(204).end();
}

/** GET /api/attachments/:id  ->  { chunks, size } */
export async function getAttachmentMeta(req: Request, res: Response): Promise<void> {
  const attachment = await prisma.attachment.findUnique({ where: { id: req.params.id } });
  if (!attachment || !attachment.complete) {
    res.status(404).json({ error: "This file is no longer available." });
    return;
  }
  res.json({ chunks: attachment.totalChunks, size: attachment.size });
}

/** GET /api/attachments/:id/chunks/:index  ->  raw bytes */
export async function getChunk(req: Request, res: Response): Promise<void> {
  const index = Number(req.params.index);
  if (!Number.isInteger(index) || index < 0) {
    res.status(400).json({ error: "Invalid chunk index." });
    return;
  }

  const chunk = await prisma.attachmentChunk.findUnique({
    where: { attachmentId_index: { attachmentId: req.params.id, index } },
    include: { attachment: { select: { complete: true } } },
  });
  if (!chunk || !chunk.attachment.complete) {
    res.status(404).json({ error: "This file is no longer available." });
    return;
  }

  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Cache-Control", "private, no-store");
  res.send(Buffer.from(chunk.data));
}

/** Drops expired files and abandoned half-uploads (chunks go with them via ON DELETE CASCADE). */
export async function purgeExpiredAttachments(): Promise<void> {
  const now = Date.now();
  const result = await prisma.attachment.deleteMany({
    where: {
      OR: [
        { createdAt: { lt: new Date(now - ATTACHMENT_TTL_MS) } },
        { complete: false, createdAt: { lt: new Date(now - ABANDONED_UPLOAD_MS) } },
      ],
    },
  });
  if (result.count > 0) console.log(`Purged ${result.count} expired attachment(s).`);
}
