import { io, Socket } from "socket.io-client";

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

export function connectSignalSocket(baseUrl: string, token: string): Socket {
  return io(baseUrl, {
    auth: { token },
    transports: ["websocket"],
  });
}

export function onSignalMessage(socket: Socket, handler: (msg: InboundSignalMessage) => void): void {
  socket.on("signal:message", handler);
}

export function onSignalReceipt(socket: Socket, handler: (evt: SignalReceiptEvent) => void): void {
  socket.on("signal:receipt", handler);
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

export function sendReceipt(
  socket: Socket,
  messageId: string,
  status: "DELIVERED" | "READ"
): Promise<SocketAck> {
  return new Promise((resolve) => {
    socket.emit("signal:receipt", { messageId, status }, resolve);
  });
}
