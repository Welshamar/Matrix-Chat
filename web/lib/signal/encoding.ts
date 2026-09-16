/**
 * libsignal-protocol-typescript speaks in "binary strings" (one char per
 * byte, code points 0-255) for wire-format message bodies. These helpers
 * convert to/from base64 so the network layer only ever handles base64
 * text, per the Message schema (`ciphertext` is a base64 blob).
 */
export function binaryStringToBase64(binary: string): string {
  return window.btoa(binary);
}

export function base64ToBinaryString(base64: string): string {
  return window.atob(base64);
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return binaryStringToBase64(binary);
}

export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = base64ToBinaryString(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
