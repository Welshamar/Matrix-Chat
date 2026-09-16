import { Request, Response } from "express";
import { prisma } from "../db/prisma";
import { UploadPreKeyBundleDTO } from "../types/signal.types";

function isValidUploadPayload(body: unknown): body is UploadPreKeyBundleDTO {
  const b = body as Partial<UploadPreKeyBundleDTO> | null;
  return !!(
    b &&
    typeof b.registrationId === "number" &&
    typeof b.identityKey === "string" &&
    b.signedPreKey &&
    typeof b.signedPreKey.keyId === "number" &&
    typeof b.signedPreKey.publicKey === "string" &&
    typeof b.signedPreKey.signature === "string" &&
    Array.isArray(b.oneTimePreKeys) &&
    b.oneTimePreKeys.every(
      (k) => typeof k.keyId === "number" && typeof k.publicKey === "string"
    )
  );
}

/**
 * POST /api/keys/prekey-bundle
 * Publishes this device's public identity key, current signed prekey, and a
 * fresh batch of one-time prekeys. Never receives or stores private keys.
 */
export async function uploadPreKeyBundle(req: Request, res: Response): Promise<void> {
  const userId = req.userId!;
  const body = req.body;

  if (!isValidUploadPayload(body)) {
    res.status(400).json({ error: "Malformed pre-key bundle payload." });
    return;
  }

  await prisma.$transaction(async (tx) => {
    await tx.identityKey.upsert({
      where: { userId },
      create: { userId, publicKey: body.identityKey },
      update: { publicKey: body.identityKey },
    });

    await tx.signedPreKey.upsert({
      where: { userId },
      create: {
        userId,
        keyId: body.signedPreKey.keyId,
        publicKey: body.signedPreKey.publicKey,
        signature: body.signedPreKey.signature,
      },
      update: {
        keyId: body.signedPreKey.keyId,
        publicKey: body.signedPreKey.publicKey,
        signature: body.signedPreKey.signature,
      },
    });

    await tx.user.update({
      where: { id: userId },
      data: { registrationId: body.registrationId },
    });

    if (body.oneTimePreKeys.length > 0) {
      await tx.oneTimePreKey.createMany({
        data: body.oneTimePreKeys.map((k) => ({
          userId,
          keyId: k.keyId,
          publicKey: k.publicKey,
        })),
        skipDuplicates: true,
      });
    }
  });

  res.status(201).json({ status: "ok" });
}

/**
 * GET /api/keys/prekey-bundle/:userId
 * Returns everything a caller needs to run X3DH against `userId`: identity
 * key, current signed prekey (+ signature), and one unused one-time prekey
 * (atomically marked used so it is never issued twice).
 */
export async function fetchPreKeyBundle(req: Request, res: Response): Promise<void> {
  const { userId } = req.params;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { identityKey: true, signedPreKey: true },
  });

  if (!user || !user.identityKey || !user.signedPreKey || user.registrationId === null) {
    res.status(404).json({ error: "No published key bundle for this user." });
    return;
  }

  const oneTimePreKey = await prisma.$transaction(async (tx) => {
    const available = await tx.oneTimePreKey.findFirst({
      where: { userId, used: false },
      orderBy: { keyId: "asc" },
    });

    if (!available) return null;

    await tx.oneTimePreKey.update({
      where: { id: available.id },
      data: { used: true },
    });

    return available;
  });

  res.json({
    userId: user.id,
    registrationId: user.registrationId,
    identityKey: user.identityKey.publicKey,
    signedPreKey: {
      keyId: user.signedPreKey.keyId,
      publicKey: user.signedPreKey.publicKey,
      signature: user.signedPreKey.signature,
    },
    preKey: oneTimePreKey
      ? { keyId: oneTimePreKey.keyId, publicKey: oneTimePreKey.publicKey }
      : null,
  });
}
