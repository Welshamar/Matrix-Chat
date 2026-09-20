import { useMemo } from "react";

// How long a reaction floats on screen before it's removed.
export const CALL_REACTION_LIFETIME_MS = 3600;

export const CALL_REACTION_EMOJIS = ["💖", "👍", "🎉", "👏", "😂", "😮", "😢"];

export interface CallReaction {
  id: string;
  emoji: string;
  // Who sent it -- "You" for my own taps, otherwise the peer's username.
  name: string;
  // Where along the bottom it starts (percent of the width) and how far it
  // sways sideways while rising (px), so a burst of taps fans out naturally.
  left: number;
  sway: number;
}

const CONFETTI_COLORS = ["#ff5252", "#ffca28", "#42a5f5", "#66bb6a", "#ab47bc", "#ff7043"];

// Party popper: a quick radial burst of coloured flecks behind the emoji.
function Confetti() {
  const flecks = useMemo(
    () =>
      Array.from({ length: 16 }, (_, i) => {
        const angle = (i / 16) * Math.PI * 2 + Math.random() * 0.4;
        const dist = 46 + Math.random() * 46;
        return {
          dx: Math.cos(angle) * dist,
          dy: Math.sin(angle) * dist - 12,
          rot: Math.round(Math.random() * 540 - 270),
          color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
          delay: Math.random() * 0.12,
        };
      }),
    []
  );
  return (
    <span className="call-confetti" aria-hidden="true">
      {flecks.map((f, i) => (
        <i
          key={i}
          style={
            {
              "--dx": `${f.dx}px`,
              "--dy": `${f.dy}px`,
              "--rot": `${f.rot}deg`,
              background: f.color,
              animationDelay: `${f.delay}s`,
            } as React.CSSProperties
          }
        />
      ))}
    </span>
  );
}

/** Emojis drift up from the bottom of the call screen, each with the sender's
 *  name underneath -- the same idea as Google Meet's reactions. Purely visual
 *  and non-interactive, so it never blocks taps on the call underneath. */
export function CallReactionsLayer({ reactions }: { reactions: CallReaction[] }) {
  return (
    <div className="call-reactions-layer" aria-hidden="true" data-testid="call-reactions">
      {reactions.map((r) => (
        <div
          key={r.id}
          className="call-reaction"
          data-testid="call-reaction"
          style={{ left: `${r.left}%`, "--sway": `${r.sway}px`, "--life": `${CALL_REACTION_LIFETIME_MS}ms` } as React.CSSProperties}
        >
          <span className="call-reaction-emoji">
            {r.emoji}
            {r.emoji === "🎉" && <Confetti />}
          </span>
          <span className="call-reaction-name">{r.name}</span>
        </div>
      ))}
    </div>
  );
}

/** The pill of emojis that pops up above the call controls. */
export function CallReactionTray({ onReact }: { onReact: (emoji: string) => void }) {
  return (
    <div className="call-reaction-tray" role="group" aria-label="Reactions">
      {CALL_REACTION_EMOJIS.map((emoji) => (
        <button key={emoji} type="button" className="call-reaction-pick" onClick={() => onReact(emoji)} aria-label={`React with ${emoji}`}>
          {emoji}
        </button>
      ))}
    </div>
  );
}
