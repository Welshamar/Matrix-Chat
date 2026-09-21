import { useRef, useState } from "react";
import { MAX_FILE_BYTES } from "@/lib/attachments";

// Files travel untouched (no resizing or recompression). Small ones ride inside
// the message; anything bigger is encrypted in chunks and uploaded separately
// (see lib/attachments.ts), which is what makes videos and big documents work.
interface FileAttachButtonProps {
  onFileSelected: (file: File) => void;
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

    onFileSelected(file);
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
