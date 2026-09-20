import { Server, Socket } from "socket.io";
import { isUserOnline, userRoom } from "./signal.gateway";
import {
  CallAnswerPayload,
  CallCameraPayload,
  CallEndPayload,
  CallIcePayload,
  CallInvitePayload,
  CallMutePayload,
  CallReactionPayload,
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

function isValidCameraPayload(p: unknown): p is CallCameraPayload {
  const v = p as Partial<CallCameraPayload> | null;
  return !!(v && isNonEmptyString(v.toUserId) && isNonEmptyString(v.callId) && typeof v.on === "boolean");
}

// A reaction is a single emoji glyph, never free text: this is relayed to the
// other person's screen and rendered, so keep it tiny and bounded.
const MAX_REACTION_LENGTH = 16;
function isValidReactionPayload(p: unknown): p is CallReactionPayload {
  const v = p as Partial<CallReactionPayload> | null;
  return !!(
    v &&
    isNonEmptyString(v.toUserId) &&
    isNonEmptyString(v.callId) &&
    isNonEmptyString(v.emoji) &&
    v.emoji.length <= MAX_REACTION_LENGTH
  );
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
        video: payload.video === true,
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

    // The other side's camera turned on/off, so it can show an avatar
    // placeholder instead of a frozen or black frame.
    socket.on("call:camera", (payload: unknown) => {
      if (!isValidCameraPayload(payload)) return;
      io.to(userRoom(payload.toUserId)).emit("call:peer-camera", {
        fromUserId: userId,
        callId: payload.callId,
        on: payload.on,
      });
    });

    // Emoji reactions that float up the other person's screen.
    socket.on("call:reaction", (payload: unknown) => {
      if (!isValidReactionPayload(payload)) return;
      io.to(userRoom(payload.toUserId)).emit("call:reacted", {
        fromUserId: userId,
        callId: payload.callId,
        emoji: payload.emoji,
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
