import { useRef, useState } from "react";
import { Avatar } from "./Avatar";

const AVATAR_SIZE_PX = 256;
const JPEG_QUALITY = 0.85;

function resizeImageToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read the selected file."));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("Could not decode the selected image."));
      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = AVATAR_SIZE_PX;
        canvas.height = AVATAR_SIZE_PX;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          reject(new Error("Canvas not supported."));
          return;
        }
        // Cover-crop to a square so the avatar isn't stretched.
        const scale = Math.max(AVATAR_SIZE_PX / img.width, AVATAR_SIZE_PX / img.height);
        const w = img.width * scale;
        const h = img.height * scale;
        ctx.drawImage(img, (AVATAR_SIZE_PX - w) / 2, (AVATAR_SIZE_PX - h) / 2, w, h);
        resolve(canvas.toDataURL("image/jpeg", JPEG_QUALITY));
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  });
}

interface ProfileModalProps {
  username: string;
  avatarUrl: string | null;
  statusText: string | null;
  onSave: (patch: { avatarUrl?: string | null; statusText?: string | null }) => Promise<void>;
  onClose: () => void;
}

export function ProfileModal({ username, avatarUrl, statusText, onSave, onClose }: ProfileModalProps) {
  const [preview, setPreview] = useState<string | null>(avatarUrl);
  const [status, setStatus] = useState(statusText ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setError("Please choose an image file.");
      return;
    }
    try {
      setError(null);
      const dataUrl = await resizeImageToDataUrl(file);
      setPreview(dataUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to process image.");
    }
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const patch: { avatarUrl?: string | null; statusText?: string | null } = {};
      if (preview !== avatarUrl) patch.avatarUrl = preview;
      if (status !== (statusText ?? "")) patch.statusText = status;
      await onSave(patch);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save profile.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="modal-backdrop" onClick={onClose} />
      <div className="modal profile-modal">
        <h2 className="modal-title">Profile</h2>

        <div className="profile-avatar-row">
          <button
            type="button"
            className="profile-avatar-button"
            onClick={() => fileInputRef.current?.click()}
            aria-label="Change profile picture"
          >
            <Avatar name={username} avatarUrl={preview} size={96} />
            <span className="profile-avatar-edit">✏️</span>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            style={{ display: "none" }}
            onChange={handleFileChange}
          />
        </div>

        <div className="field">
          <label>Username</label>
          <input value={username} disabled />
        </div>

        <div className="field">
          <label>Status</label>
          <input
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            maxLength={140}
            placeholder="Hey there! I am using Matrix Chat."
          />
        </div>

        {error && <div className="error-banner">{error}</div>}

        <div className="modal-actions">
          <button className="btn-secondary" type="button" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button className="btn-primary" type="button" onClick={handleSave} disabled={saving}>
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </div>
    </>
  );
}
