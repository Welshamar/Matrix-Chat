import { useRef, useState } from "react";
import { FileMeta } from "@/lib/messageEnvelope";

// Files travel untouched (no resizing or recompression), so this is the
// ceiling for sending an original. Base64 inflates size by ~4/3 twice over --
// once as the data URL inside the envelope, once as the encrypted payload --
// so a frame is ~1.8x the file and has to fit the server's maxHttpBufferSize
// (40MB). 16MB covers full-resolution phone photos and short clips.
const MAX_FILE_BYTES = 16 * 1024 * 1024;

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read the selected file."));
    reader.onload = () => resolve(reader.result as string);
    reader.readAsDataURL(file);
  });
}

interface FileAttachButtonProps {
  onFileSelected: (dataUrl: string, meta: FileMeta) => void;
  disabled?: boolean;
}

export function FileAttachButton({ onFileSelected, disabled }: FileAttachButtonProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow picking the same file again later
    if (!file) return;

    setError(null);
    if (file.size > MAX_FILE_BYTES) {
      setError(`"${file.name}" is too large — attachments are limited to ${MAX_FILE_BYTES / (1024 * 1024)} MB.`);
      return;
    }

    try {
      const dataUrl = await readAsDataUrl(file);
      onFileSelected(dataUrl, { name: file.name, mime: file.type || "application/octet-stream", size: file.size });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to read the selected file.");
    }
  }

  return (
    <>
      <button
        type="button"
        className="composer-emoji-btn"
        onClick={() => inputRef.current?.click()}
        disabled={disabled}
        aria-label="Attach file"
        title="Attach file"
      >
        <svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path
            d="M16.5 6.5 8.4 14.6a3 3 0 1 0 4.24 4.24l8.02-8.02a5 5 0 1 0-7.07-7.07L5.57 11.77a7 7 0 1 0 9.9 9.9"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      <input ref={inputRef} type="file" hidden onChange={handleChange} disabled={disabled} />
      {error && <div className="inline-error attach-error">{error}</div>}
    </>
  );
}
