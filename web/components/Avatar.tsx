const PALETTE = ["#00a884", "#e17076", "#7bc862", "#65aadd", "#a695e7", "#ee7aae", "#e0a542"];

export function avatarColorFor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash << 5) - hash + seed.charCodeAt(i);
  return PALETTE[Math.abs(hash) % PALETTE.length];
}

interface AvatarProps {
  name: string;
  avatarUrl?: string | null;
  size?: number;
  // Green online dot, bottom-right. Omit (rather than false) for a group,
  // or anyone whose presence isn't known yet -- so "not shown" reads as "no
  // data" rather than a confident (and possibly wrong) "offline".
  online?: boolean;
}

export function Avatar({ name, avatarUrl, size = 40, online }: AvatarProps) {
  const style = { width: size, height: size, fontSize: size * 0.42 };
  const dot = online ? (
    <span className="avatar-online-dot" style={{ width: size * 0.28, height: size * 0.28 }} aria-label="Online" />
  ) : null;

  if (avatarUrl) {
    return (
      <span className="avatar-wrap">
        <img className="avatar" src={avatarUrl} alt={name} style={style} />
        {dot}
      </span>
    );
  }

  const initial = name.trim().charAt(0).toUpperCase() || "?";
  return (
    <span className="avatar-wrap">
      <div className="avatar avatar-fallback" style={{ ...style, background: avatarColorFor(name) }}>
        {initial}
      </div>
      {dot}
    </span>
  );
}
