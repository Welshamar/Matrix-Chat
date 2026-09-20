import { Server, Socket } from "socket.io";
import { isUserOnline, userRoom } from "./signal.gateway";
import {
  CallAnswerPayload,
  CallEndPayload,
  CallIcePayload,
  CallInvitePayload,
  CallMutePayload,
  SocketAck,
} from "../types/signal.types";

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function isValidInvitePayload(p: unknown): p is CallInvitePayload {
  const v = p as Partial<CallInvitePayload> | null;
  return !!(v && isNonEmptyString(v.toUserId) && isNonEmptyString(v.callId) && v.sdp);
}

function isValidAnswerPayload(p: unknown): p is CallAnswerPayload {
  const v = p as Partial<CallAnswerPayload> | null;
  return !!(v && isNonEmptyString(v.toUserId) && isNonEmptyString(v.callId) && v.sdp);
}

function isValidIcePayload(p: unknown): p is CallIcePayload {
  const v = p as Partial<CallIcePayload> | null;
  return !!(v && isNonEmptyString(v.toUserId) && isNonEmptyString(v.callId) && v.candidate);
}

function isValidMutePayload(p: unknown): p is CallMutePayload {
  const v = p as Partial<CallMutePayload> | null;
  return !!(v && isNonEmptyString(v.toUserId) && isNonEmptyString(v.callId) && typeof v.muted === "boolean");
}

function isValidEndPayload(p: unknown): p is CallEndPayload {
  const v = p as Partial<CallEndPayload> | null;
  return !!(v && isNonEmptyString(v.toUserId) && isNonEmptyString(v.callId));
}

/** Pure signaling relay for 1:1 voice calls: forwards SDP offers/answers and
 *  ICE candidates by userId, exactly like the message gateway forwards
 *  ciphertext. There is nothing to persist — a call leaves no history. */
export function registerCallGateway(io: Server): void {
  io.on("connection", (socket: Socket) => {
    const userId = socket.data.userId as string;

    socket.on("call:invite", (payload: unknown, ack?: (res: SocketAck) => void) => {
      if (!isValidInvitePayload(payload)) {
        ack?.({ ok: false, error: "Malformed call:invite payload." });
        return;
      }
      if (!isUserOnline(payload.toUserId)) {
        ack?.({ ok: false, error: "That person is offline." });
        return;
      }

      io.to(userRoom(payload.toUserId)).emit("call:incoming", {
        fromUserId: userId,
        fromUsername: (socket.data.username as string) ?? "Unknown",
        callId: payload.callId,
        sdp: payload.sdp,
      });
      ack?.({ ok: true });
    });

    socket.on("call:answer", (payload: unknown) => {
      if (!isValidAnswerPayload(payload)) return;
      io.to(userRoom(payload.toUserId)).emit("call:answered", {
        fromUserId: userId,
        callId: payload.callId,
        sdp: payload.sdp,
      });
    });

    socket.on("call:ice", (payload: unknown) => {
      if (!isValidIcePayload(payload)) return;
      io.to(userRoom(payload.toUserId)).emit("call:ice", {
        fromUserId: userId,
        callId: payload.callId,
        candidate: payload.candidate,
      });
    });

    // So the other side can show a "muted" indicator, like WhatsApp does.
    socket.on("call:mute", (payload: unknown) => {
      if (!isValidMutePayload(payload)) return;
      io.to(userRoom(payload.toUserId)).emit("call:peer-muted", {
        fromUserId: userId,
        callId: payload.callId,
        muted: payload.muted,
      });
    });

    socket.on("call:reject", (payload: unknown) => {
      if (!isValidEndPayload(payload)) return;
      io.to(userRoom(payload.toUserId)).emit("call:rejected", { fromUserId: userId, callId: payload.callId });
    });

    socket.on("call:end", (payload: unknown) => {
      if (!isValidEndPayload(payload)) return;
      io.to(userRoom(payload.toUserId)).emit("call:ended", { fromUserId: userId, callId: payload.callId });
    });
  });
}
