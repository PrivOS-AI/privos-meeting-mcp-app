/**
 * Initials avatar colored by `colorKey` (assigned by `profile-store.ts`'s
 * `pickColorKey` on the backend — 6-color palette, see
 * `theme/speaker-identity.css`).
 */
export interface SpeakerAvatarProps {
  name: string;
  colorKey?: string;
  size?: number;
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function SpeakerAvatar({ name, colorKey = 'blue', size = 32 }: SpeakerAvatarProps) {
  return (
    <span
      className={`ma-speaker-avatar ma-speaker-avatar--${colorKey}`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.4) }}
      aria-hidden="true"
    >
      {initialsOf(name)}
    </span>
  );
}
