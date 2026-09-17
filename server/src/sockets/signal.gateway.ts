import { Server, Socket } from "socket.io";
import { prisma } from "../db/prisma";
import { verifySocketToken } from "../middleware/auth.middleware";
import { sendPushNotification } from "../lib/push";
import {
  SignalMessagePayload,
  SignalReceiptPayload,
  SignalViewedPayload,
  SocketAck,
} from "../types/signal.types";

// userId -> connected socket ids, for presence/multi-tab awareness only.
const onlineSockets = new Map<string, Set<string>>();

export function userRoom(userId: string): string {
  return `user:${userId}`;
}

export function isUserOnline(userId: string): boolean {
  return (onlineSockets.get(userId)?.size ?? 0) > 0;
}

function isValidMessagePayload(p: unknown): p is SignalMessagePayload {
  const m = p as Partial<SignalMessagePayload> | null;
  return !!(
    m &&
    typeof m.recipientId === "string" &&
    typeof m.ciphertext === "string" &&
    typeof m.signalMessageType === "number"
  );
}

function isValidReceiptPayload(p: unknown): p is SignalReceiptPayload {
  const r = p as Partial<SignalReceiptPayload> | null;
  return !!(r && typeof r.messageId === "string" && (r.status === "DELIVERED" || r.status === "READ"));
}

function isValidViewedPayload(p: unknown): p is SignalViewedPayload {
  const v = p as Partial<SignalViewedPayload> | null;
  return !!(v && typeof v.messageId === "string");
}

/** Wires up the zero-knowledge relay: the server persists and forwards
 *  ciphertext blobs verbatim, and never inspects, decrypts, or logs them. */
export function registerSignalGateway(io: Server): void {
  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token as string | undefined;
      socket.data.userId = verifySocketToken(token);
      next();
    } catch {
      next(new Error("Unauthorized"));
    }
  });

  io.on("connection", (socket: Socket) => {
    const userId = socket.data.userId as string;
    socket.join(userRoom(userId));

    // Looked up once per connection (not per call:invite) so a slow/flaky
    // DB round trip can't fail an otherwise-healthy call — see call.gateway.ts.
    prisma.user
      .findUnique({ where: { id: userId }, select: { username: true } })
      .then((user) => {
        socket.data.username = user?.username ?? "Unknown";
      })
      .catch(() => {
        socket.data.username = "Unknown";
      });

    const sockets = onlineSockets.get(userId) ?? new Set<string>();
    sockets.add(socket.id);
    onlineSockets.set(userId, sockets);

    socket.on(
      "signal:message",
      async (payload: unknown, ack?: (res: SocketAck) => void) => {
        if (!isValidMessagePayload(payload)) {
          ack?.({ ok: false, error: "Malformed signal:message payload." });
          return;
        }

        try {
          // A client can only tag a send with a groupId it's actually a
          // member of — otherwise it's silently treated as a plain 1:1
          // send, so a bad client can't spoof messages into someone
          // else's group thread (it still can't read anything either
          // way; this is about thread integrity, not confidentiality).
          let groupId: string | undefined;
          if (payload.groupId) {
            const membership = await prisma.groupMember.findUnique({
              where: { groupId_userId: { groupId: payload.groupId, userId } },
            });
            if (membership) groupId = payload.groupId;
          }

          // `payload.ciphertext` is an opaque Double Ratchet blob: stored
          // and relayed byte-for-byte, never parsed or decrypted here.
          const message = await prisma.message.create({
            data: {
              senderId: userId,
              recipientId: payload.recipientId,
              ciphertext: payload.ciphertext,
              signalMessageType: payload.signalMessageType,
              viewOnce: payload.viewOnce ?? false,
              kind: payload.kind ?? "TEXT",
              groupId,
            },
          });

          io.to(userRoom(payload.recipientId)).emit("signal:message", {
            id: message.id,
            senderId: message.senderId,
            ciphertext: message.ciphertext,
            signalMessageType: message.signalMessageType,
            viewOnce: message.viewOnce,
            kind: message.kind,
            groupId: message.groupId,
            timestamp: message.timestamp,
          });

          // The recipient has no live socket to deliver over right now —
          // it'll still be waiting in their inbox next time they connect,
          // but a push is the only way to actually notify them meanwhile.
          // Best-effort and fire-and-forget: never blocks the ack, and the
          // notification body stays generic since the server has no
          // plaintext to put in it either way.
          if (!isUserOnline(payload.recipientId)) {
            prisma.user
              .findUnique({ where: { id: payload.recipientId }, select: { fcmToken: true } })
              .then((recipient) => {
                if (recipient?.fcmToken) {
                  const senderUsername = (socket.data.username as string) ?? "Someone";
                  return sendPushNotification(recipient.fcmToken, senderUsername, "Sent you a message");
                }
              })
              .catch((err) => console.error("Failed to send push notification:", err));
          }

          ack?.({ ok: true, messageId: message.id, clientMessageId: payload.clientMessageId });
        } catch {
          ack?.({ ok: false, error: "Failed to relay message." });
        }
      }
    );

    socket.on(
      "signal:receipt",
      async (payload: unknown, ack?: (res: SocketAck) => void) => {
        if (!isValidReceiptPayload(payload)) {
          ack?.({ ok: false, error: "Malformed signal:receipt payload." });
          return;
        }

        try {
          const message = await prisma.message.update({
            where: { id: payload.messageId },
            data: { status: payload.status },
          });

          io.to(userRoom(message.senderId)).emit("signal:receipt", {
            messageId: message.id,
            status: message.status,
            from: userId,
          });

          ack?.({ ok: true });
        } catch {
          ack?.({ ok: false, error: "Failed to update receipt." });
        }
      }
    );

    // A view-once message has been shown on the recipient's screen: drop
    // the ciphertext server-side (data minimization) and let the sender
    // know it was consumed.
    socket.on(
      "signal:viewed",
      async (payload: unknown, ack?: (res: SocketAck) => void) => {
        if (!isValidViewedPayload(payload)) {
          ack?.({ ok: false, error: "Malformed signal:viewed payload." });
          return;
        }

        try {
          const message = await prisma.message.update({
            where: { id: payload.messageId },
            data: { ciphertext: null, viewedAt: new Date(), status: "READ" },
          });

          io.to(userRoom(message.senderId)).emit("signal:viewed", {
            messageId: message.id,
            from: userId,
          });

          ack?.({ ok: true });
        } catch {
          ack?.({ ok: false, error: "Failed to record view." });
        }
      }
    );

    socket.on("disconnect", () => {
      const set = onlineSockets.get(userId);
      set?.delete(socket.id);
      if (set && set.size === 0) onlineSockets.delete(userId);
    });
  });
}
