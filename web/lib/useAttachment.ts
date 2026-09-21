import { useCallback, useEffect, useRef, useState } from "react";
import { LocalMessage } from "./localDb";
import {
  AUTO_DOWNLOAD_IMAGE_MAX_BYTES,
  AttachmentError,
  getAttachmentUserId,
  getCachedFile,
  loadAttachmentFile,
} from "./attachments";

export type AttachmentStatus =
  // Not an attachment at all (a small file sent inline, or not a file) -- use message.body.
  | "inline"
  | "checking"
  // Not on this device yet; waiting for a tap.
  | "idle"
  | "downloading"
  | "ready"
  | "error";

export interface AttachmentState {
  status: AttachmentStatus;
  // A blob: URL for <img>/<video> once the file is on this device.
  url: string | null;
  blob: Blob | null;
  progress: number;
  error: string | null;
  // Downloads (or reuses the local copy) and resolves with the file, or null if it failed.
  ensure: () => Promise<Blob | null>;
}

/** Local availability + download control for a message's heavy-file attachment. */
export function useAttachment(message: LocalMessage): AttachmentState {
  const file = message.file;
  const att = file?.att;
  const mime = file?.mime ?? "application/octet-stream";
  const isImage = mime.startsWith("image/");
  const auto = isImage && (file?.size ?? 0) <= AUTO_DOWNLOAD_IMAGE_MAX_BYTES;

  const [status, setStatus] = useState<AttachmentStatus>(att ? "checking" : "inline");
  const [blob, setBlob] = useState<Blob | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const messageId = message.id;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const ensure = useCallback(async (): Promise<Blob | null> => {
    if (!att) return null;
    setError(null);
    setStatus("downloading");
    try {
      const result = await loadAttachmentFile(messageId, att, mime, (fraction) => {
        if (mounted.current) setProgress(fraction);
      });
      if (mounted.current) {
        setBlob(result);
        setStatus("ready");
      }
      return result;
    } catch (err) {
      if (mounted.current) {
        setStatus("error");
        setError(err instanceof AttachmentError || err instanceof Error ? err.message : "Couldn't download the file.");
      }
      return null;
    }
  }, [att, messageId, mime]);

  // On mount: use the copy already on this device if there is one; otherwise
  // fetch photos automatically and leave everything else for a tap.
  useEffect(() => {
    if (!att) {
      setStatus("inline");
      return;
    }
    let cancelled = false;
    (async () => {
      const userId = getAttachmentUserId();
      const cached = userId ? await getCachedFile(userId, messageId) : undefined;
      if (cancelled) return;
      if (cached) {
        setBlob(cached);
        setStatus("ready");
      } else if (auto) {
        ensure();
      } else {
        setStatus("idle");
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [att?.id, messageId]);

  useEffect(() => {
    if (!blob) {
      setUrl(null);
      return;
    }
    const objectUrl = URL.createObjectURL(blob);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [blob]);

  return { status, url, blob, progress, error, ensure };
}
