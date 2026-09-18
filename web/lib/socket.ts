import { io, Socket } from "socket.io-client";
import { API_URL } from "./api";

export type MessageKind = "TEXT" | "VOICE" | "FILE";

export interface InboundSignalMessage {
  id: string;
  senderId: string;
  ciphertext: string;
  signalMessageType: number;
  viewOnce: boolean;
  kind: MessageKind;
  groupId: string | null;
  timestamp: string;
}

export interface SignalReceiptEvent {
  messageId: string;
  status: "DELIVERED" | "READ";
  from: string;
}

export interface SignalViewedEvent {
  messageId: string;
  from: string;
}

export interface SignalTypingEvent {
  from: string;
  username: string;
  groupId?: string;
  typing: boolean;
}

interface SocketAck {
  ok: boolean;
  error?: string;
  messageId?: string;
}

export interface IncomingCallEvent {
  fromUserId: string;
  fromUsername: string;
  callId: string;
  sdp: RTCSessionDescriptionInit;
}

export interface CallAnsweredEvent {
  fromUserId: string;
  callId: string;
  sdp: RTCSessionDescriptionInit;
}

export interface CallIceEvent {
  fromUserId: string;
  callId: string;
  candidate: RTCIceCandidateInit;
}

export interface CallEndedEvent {
  fromUserId: string;
  callId: string;
}

export function connectSignalSocket(token: string): Socket {
  return io(API_URL, { auth: { token }, transports: ["websocket"] });
}

export interface SendSignalMessageOptions {
  recipientId: string;
  ciphertext: string;
  signalMessageType: number;
  viewOnce?: boolean;
  kind?: MessageKind;
  groupId?: string;
}

export function sendSignalMessage(socket: Socket, opts: SendSignalMessageOptions): Promise<SocketAck> {
  return new Promise((resolve) => {
    socket.emit(
      "signal:message",
      {
        recipientId: opts.recipientId,
        ciphertext: opts.ciphertext,
        signalMessageType: opts.signalMessageType,
        viewOnce: opts.viewOnce ?? false,
        kind: opts.kind ?? "TEXT",
        groupId: opts.groupId,
      },
      resolve
    );
  });
}

export function sendReceipt(socket: Socket, messageId: string, status: "DELIVERED" | "READ"): Promise<SocketAck> {
  return new Promise((resolve) => {
    socket.emit("signal:receipt", { messageId, status }, resolve);
  });
}

export function sendViewed(socket: Socket, messageId: string): Promise<SocketAck> {
  return new Promise((resolve) => {
    socket.emit("signal:viewed", { messageId }, resolve);
  });
}

// Tells the server whether this tab/app instance is actually in the
// foreground right now — a connected socket alone isn't enough to skip a
// push notification, since the app can stay connected for a while after
// being backgrounded (Android) or losing focus (a background browser tab).
export function sendVisibility(socket: Socket, visible: boolean): void {
  socket.emit("presence:visibility", { visible });
}

// Composing-state presence — not message content, so it's sent in the
// clear (like receipts) rather than through the Signal ratchet. Fire and
// forget: a dropped typing ping just means the indicator stays hidden a
// little longer, never anything worse.
export function sendTyping(socket: Socket, target: { recipientId?: string; groupId?: string }, typing: boolean): void {
  socket.emit("signal:typing", { ...target, typing });
}
