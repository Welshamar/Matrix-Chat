import { LocalMessage } from "@/lib/localDb";
import { Avatar } from "./Avatar";

interface ContactDetailsPanelProps {
  name: string;
  avatarUrl?: string | null;
  status: string;
  messages: LocalMessage[];
  onManageGroup?: () => void;
  onClose: () => void;
}

const MEDIA_GRID_LIMIT = 9;

export function ContactDetailsPanel({ name, avatarUrl, status, messages, onManageGroup, onClose }: ContactDetailsPanelProps) {
  const media = messages
    .filter((m) => m.kind === "FILE" && m.file?.mime.startsWith("image/"))
    .slice(-MEDIA_GRID_LIMIT)
    .reverse();

  return (
    <aside className="contact-details-panel">
      <div className="contact-details-header">
        <h3 className="contact-details-title">Contact Details</h3>
        <button type="button" className="contact-details-close" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>
      <div className="contact-details-body">
        <Avatar name={name} avatarUrl={avatarUrl} size={88} />
        <div className="contact-details-name">{name}</div>
        <div className="contact-details-status">{status}</div>

        {onManageGroup && (
          <button type="button" className="btn-secondary contact-details-manage" onClick={onManageGroup}>
            Manage members
          </button>
        )}

        <div className="contact-details-media">
          <h4 className="contact-details-media-title">Media</h4>
          {media.length === 0 ? (
            <div className="contact-details-media-empty">No media shared yet.</div>
          ) : (
            <div className="contact-details-media-grid">
              {media.map((m) => (
                <a key={m.id} href={m.body} target="_blank" rel="noopener noreferrer">
                  <img src={m.body} alt={m.file?.name ?? "Shared image"} />
                </a>
              ))}
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
