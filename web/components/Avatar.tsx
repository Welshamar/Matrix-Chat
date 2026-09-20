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
}

export function Avatar({ name, avatarUrl, size = 40 }: AvatarProps) {
  const style = { width: size, height: size, fontSize: size * 0.42 };

  if (avatarUrl) {
    return <img className="avatar" src={avatarUrl} alt={name} style={style} />;
  }

  const initial = name.trim().charAt(0).toUpperCase() || "?";
  return (
    <div className="avatar avatar-fallback" style={{ ...style, background: avatarColorFor(name) }}>
      {initial}
    </div>
  );
}
