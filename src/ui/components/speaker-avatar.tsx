/**
 * A person's avatar: their PrivOS photo when the app can tell who they are
 * (`data/people.tsx` — by user id, username, or a name only one room member
 * has), otherwise initials colored by `colorKey` (assigned by
 * `profile-store.ts`'s `pickColorKey` on the backend — 6-color palette, see
 * `theme/speaker-identity.css`). A photo that fails to load falls back to the
 * initials.
 */
import { useEffect, useState } from 'react';

import { usePeople } from '../data/people.js';

export interface SpeakerAvatarProps {
  name: string;
  colorKey?: string;
  size?: number;
  /** The PrivOS user behind this speaker, when known. */
  userId?: string | null;
  username?: string | null;
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function SpeakerAvatar({ name, colorKey = 'blue', size = 32, userId, username }: SpeakerAvatarProps) {
  const people = usePeople();
  const src = people.avatarUrl({ userId, username, name });
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => setFailed(null), [src]);
  const showPhoto = src !== null && failed !== src;

  return (
    <span
      className={`ma-speaker-avatar ma-speaker-avatar--${colorKey}${showPhoto ? ' ma-speaker-avatar--photo' : ''}`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.4) }}
      aria-hidden="true"
    >
      {showPhoto ? (
        <img src={src} alt="" width={size} height={size} loading="lazy" decoding="async" onError={() => setFailed(src)} />
      ) : size < 28 ? (
        initialsOf(name).charAt(0)
      ) : (
        initialsOf(name)
      )}
    </span>
  );
}
