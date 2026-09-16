import { useRef, useState } from "react";
import { FileMeta } from "@/lib/messageEnvelope";

// Base64 inflates size by ~4/3, and the whole thing still has to fit inside
// one Signal-encrypted socket frame (see server maxHttpBufferSize) alongside
// JSON envelope overhead — keep real files well under that ceiling.
const MAX_FILE_BYTES = 5 * 1024 * 1024;

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
      setError(`"${file.name}" is too large — attachments are limited to 5 MB.`);
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
