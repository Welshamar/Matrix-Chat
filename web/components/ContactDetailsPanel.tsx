import { LocalMessage } from "@/lib/localDb";
import { useAttachment } from "@/lib/useAttachment";
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

// A heavy photo isn't in message.body -- it's the decrypted attachment, which
// the hook resolves from this device's copy (it's downloaded in the thread).
function MediaThumb({ message }: { message: LocalMessage }) {
  const attachment = useAttachment(message);
  const src = message.file?.att ? attachment.url : message.body;
  if (!src) return <span className="contact-details-media-pending" aria-hidden="true" />;
  return (
    <a href={src} target="_blank" rel="noopener noreferrer">
      <img src={src} alt={message.file?.name ?? "Shared image"} />
    </a>
  );
}

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
                <MediaThumb key={m.id} message={m} />
              ))}
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
