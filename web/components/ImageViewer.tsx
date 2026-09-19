import { useEffect, useRef, useState } from "react";
import { saveDataUrlFile, shareDataUrlFile } from "@/lib/saveFile";

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface ImageViewerProps {
  src: string;
  name: string;
  size: number;
  onClose: () => void;
}

// Full-screen view of an image message at its original resolution. The chat
// thumbnail is necessarily small, and a data: URL can't be opened in a new
// tab inside the Android WebView, so without this there was no way to look at
// a received photo at full quality before (or instead of) saving it.
export function ImageViewer({ src, name, size, onClose }: ImageViewerProps) {
  const [dimensions, setDimensions] = useState<{ w: number; h: number } | null>(null);
  const [actualSize, setActualSize] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const statusTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (statusTimeoutRef.current) clearTimeout(statusTimeoutRef.current);
    };
  }, [onClose]);

  function flash(message: string) {
    setStatus(message);
    if (statusTimeoutRef.current) clearTimeout(statusTimeoutRef.current);
    statusTimeoutRef.current = setTimeout(() => setStatus(null), 3500);
  }

  async function handleDownload() {
    const result = await saveDataUrlFile(src, name);
    if (result.message) flash(result.message);
  }

  async function handleShare() {
    const result = await shareDataUrlFile(src, name);
    if (!result.ok && result.message) flash(result.message);
  }

  const details = [formatFileSize(size), dimensions ? `${dimensions.w} × ${dimensions.h}` : null].filter(Boolean).join(" · ");

  return (
    <div className="image-viewer" role="dialog" aria-label="Image viewer">
      <div className="image-viewer-bar">
        <button type="button" className="image-viewer-btn" onClick={onClose} aria-label="Close image viewer">
          <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M15 5l-7 7 7 7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <div className="image-viewer-title">
          <span className="image-viewer-name">{name}</span>
          <span className="image-viewer-details">Original quality · {details}</span>
        </div>
        <button type="button" className="image-viewer-btn" onClick={handleShare} aria-label="Share image">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8">
            <circle cx="18" cy="5.5" r="2.5" />
            <circle cx="6" cy="12" r="2.5" />
            <circle cx="18" cy="18.5" r="2.5" />
            <path d="M8.2 10.7l7.6-4.2M8.2 13.3l7.6 4.2" strokeLinecap="round" />
          </svg>
        </button>
        <button type="button" className="image-viewer-btn" onClick={handleDownload} aria-label="Download image">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M12 3.5v11.5" strokeLinecap="round" />
            <path d="M7.5 11l4.5 4.5 4.5-4.5" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M5 19.5h14" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <div className={`image-viewer-stage ${actualSize ? "actual" : ""}`}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={name}
          className="image-viewer-img"
          onLoad={(e) => setDimensions({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
          onClick={() => setActualSize((v) => !v)}
        />
      </div>

      <div className="image-viewer-hint">
        {status ?? (actualSize ? "Tap to fit to screen" : "Tap the image to view at actual size")}
      </div>
    </div>
  );
}
