interface DisappearingOption {
  label: string;
  seconds: number | null;
}

const OPTIONS: DisappearingOption[] = [
  { label: "Off", seconds: null },
  { label: "24 hours", seconds: 86400 },
  { label: "7 days", seconds: 604800 },
  { label: "90 days", seconds: 7776000 },
];

interface DisappearingMessagesModalProps {
  current: number | null | undefined;
  onSelect: (seconds: number | null) => void;
  onClose: () => void;
}

export function DisappearingMessagesModal({ current, onSelect, onClose }: DisappearingMessagesModalProps) {
  return (
    <>
      <div className="modal-backdrop" onClick={onClose} />
      <div className="modal">
        <h2 className="modal-title">Disappearing messages</h2>
        <p className="modal-subtitle">
          New messages in this chat will disappear from this device after the selected time. This only affects your
          own device -- it doesn't change what the other person keeps.
        </p>
        <div className="option-list">
          {OPTIONS.map((opt) => (
            <button
              key={opt.label}
              className={`option-list-item ${(current ?? null) === opt.seconds ? "selected" : ""}`}
              onClick={() => {
                onSelect(opt.seconds);
                onClose();
              }}
            >
              {opt.label}
              {(current ?? null) === opt.seconds && <span className="option-list-check">✓</span>}
            </button>
          ))}
        </div>
        <div className="modal-actions">
          <button className="btn-secondary" type="button" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </>
  );
}
