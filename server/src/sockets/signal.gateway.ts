import { Server, Socket } from "socket.io";
import { prisma } from "../db/prisma";
import { verifySocketToken } from "../middleware/auth.middleware";
import { SignalMessagePayload, SignalReceiptPayload, SocketAck } from "../types/signal.types";

// userId -> connected socket ids, for presence/multi-tab awareness only.
const onlineSockets = new Map<string, Set<string>>();

function userRoom(userId: string): string {
  return `user:${userId}`;
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
          // `payload.ciphertext` is an opaque Double Ratchet blob: stored
          // and relayed byte-for-byte, never parsed or decrypted here.
          const message = await prisma.message.create({
            data: {
              senderId: userId,
              recipientId: payload.recipientId,
              ciphertext: payload.ciphertext,
              signalMessageType: payload.signalMessageType,
            },
          });

          io.to(userRoom(payload.recipientId)).emit("signal:message", {
            id: message.id,
            senderId: message.senderId,
            ciphertext: message.ciphertext,
            signalMessageType: message.signalMessageType,
            timestamp: message.timestamp,
          });

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

    socket.on("disconnect", () => {
      const set = onlineSockets.get(userId);
      set?.delete(socket.id);
      if (set && set.size === 0) onlineSockets.delete(userId);
    });
  });
}
