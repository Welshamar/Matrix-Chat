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

interface SocketAck {
  ok: boolean;
  error?: string;
  messageId?: string;
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
