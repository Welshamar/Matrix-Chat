import { CHAT_THEMES, ChatTheme } from "@/lib/localDb";

const THEME_LABELS: Record<ChatTheme, string> = {
  default: "Default",
  teal: "Teal",
  sunset: "Sunset",
  violet: "Violet",
  forest: "Forest",
  slate: "Slate",
};

interface ChatThemeModalProps {
  current: ChatTheme | undefined;
  onSelect: (theme: ChatTheme) => void;
  onClose: () => void;
}

export function ChatThemeModal({ current, onSelect, onClose }: ChatThemeModalProps) {
  return (
    <>
      <div className="modal-backdrop" onClick={onClose} />
      <div className="modal">
        <h2 className="modal-title">Chat theme</h2>
        <div className="theme-swatch-grid">
          {CHAT_THEMES.map((theme) => (
            <button
              key={theme}
              className={`theme-swatch theme-swatch-${theme} ${(current ?? "default") === theme ? "selected" : ""}`}
              onClick={() => {
                onSelect(theme);
                onClose();
              }}
              aria-label={THEME_LABELS[theme]}
              title={THEME_LABELS[theme]}
            >
              {(current ?? "default") === theme && <span className="theme-swatch-check">✓</span>}
            </button>
          ))}
        </div>
        <div className="modal-actions">
          <button className="btn-secondary" type="button" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </>
  );
}
