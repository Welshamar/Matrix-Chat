import { io, Socket } from "socket.io-client";
import { API_URL } from "./api";

export interface InboundSignalMessage {
  id: string;
  senderId: string;
  ciphertext: string;
  signalMessageType: number;
  timestamp: string;
}

export interface SignalReceiptEvent {
  messageId: string;
  status: "DELIVERED" | "READ";
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

export function sendSignalMessage(
  socket: Socket,
  recipientId: string,
  ciphertext: string,
  signalMessageType: number
): Promise<SocketAck> {
  return new Promise((resolve) => {
    socket.emit("signal:message", { recipientId, ciphertext, signalMessageType }, resolve);
  });
}

export function sendReceipt(socket: Socket, messageId: string, status: "DELIVERED" | "READ"): Promise<SocketAck> {
  return new Promise((resolve) => {
    socket.emit("signal:receipt", { messageId, status }, resolve);
  });
}
