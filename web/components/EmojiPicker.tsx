const EMOJIS = [
  "😀", "😂", "🥰", "😍", "😊", "😉", "😎", "🤔", "😢", "😭",
  "😡", "😱", "🥳", "😴", "🤗", "🙄", "😇", "🤩", "🥺", "😅",
  "👍", "👎", "👏", "🙏", "💪", "🤝", "👋", "✌️", "🤞", "🫶",
  "❤️", "🧡", "💛", "💚", "💙", "💜", "🖤", "🤍", "💔", "💯",
  "🔥", "✨", "🎉", "🎂", "🎁", "🌟", "⭐", "☀️", "🌈", "🍕",
  "☕", "🍔", "🍎", "⚽", "🎮", "📷", "🎵", "😷", "🤒", "💤",
];

interface EmojiPickerProps {
  onSelect: (emoji: string) => void;
  onClose: () => void;
}

export function EmojiPicker({ onSelect, onClose }: EmojiPickerProps) {
  return (
    <>
      <div className="emoji-picker-backdrop" onClick={onClose} />
      <div className="emoji-picker">
        {EMOJIS.map((emoji) => (
          <button
            key={emoji}
            type="button"
            className="emoji-picker-item"
            onClick={() => onSelect(emoji)}
            aria-label={emoji}
          >
            {emoji}
          </button>
        ))}
      </div>
    </>
  );
}
