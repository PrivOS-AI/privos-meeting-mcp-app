/**
 * Who the people in this room are, for showing their avatars: the room's
 * members (`rooms:read`, optional) and the Hub's address, where avatars are
 * public at `<hub>/avatar/<username>`. The address comes from the server
 * (`meeting_bootstrap`), else from what the browser knows of the parent page.
 *
 * A person is found by their PrivOS user id when the app knows it, otherwise
 * by a name that matches exactly one member — never a guess between two. When
 * nothing matches, or the image fails, avatars keep their initials.
 */
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { usePrivosApp, usePrivosContext } from '@privos_ai/app-react';

import { listRoomMembers, type RoomMember } from './room-members.js';

export interface PersonRef {
  userId?: string | null;
  username?: string | null;
  name?: string | null;
}

interface People {
  /** The avatar image for a person, or null when they cannot be told apart from others or the Hub is unknown. */
  avatarUrl(person: PersonRef): string | null;
  setHubOrigin(origin: string): void;
  /** The Hub's origin (`https://…`), for links people open outside this iframe; null when unknown. */
  hubOrigin: string | null;
}

const PeopleContext = createContext<People>({ avatarUrl: () => null, setHubOrigin: () => undefined, hubOrigin: null });

function httpOrigin(value: string | undefined | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null;
  } catch {
    return null;
  }
}

/** The parent page's origin as the browser exposes it to an opaque-origin frame: ancestor origins (Chromium, Safari), else the referrer. */
export function guessHubOrigin(): string | null {
  const ancestors = (window.location as Location & { ancestorOrigins?: DOMStringList }).ancestorOrigins;
  return httpOrigin(ancestors && ancestors.length > 0 ? ancestors[ancestors.length - 1] : null) ?? httpOrigin(document.referrer);
}

const fold = (name: string) => name.trim().toLowerCase().normalize('NFC');

export function PeopleProvider({ children }: { children: ReactNode }) {
  const app = usePrivosApp();
  const { roomId } = usePrivosContext();
  const [members, setMembers] = useState<RoomMember[]>([]);
  const [hub, setHub] = useState<string | null>(() => guessHubOrigin());

  useEffect(() => {
    if (!roomId) return;
    let cancelled = false;
    listRoomMembers(app, roomId)
      .then((list) => {
        if (!cancelled) setMembers(list);
      })
      .catch(() => undefined); // no rooms:read: initials stay
    return () => {
      cancelled = true;
    };
  }, [app, roomId]);

  const value = useMemo<People>(() => {
    const byId = new Map(members.map((m) => [m.id, m]));
    // A name (display name or username) that belongs to more than one member points at nobody.
    const byName = new Map<string, RoomMember | null>();
    for (const m of members) {
      for (const key of new Set([fold(m.name), fold(m.username)])) {
        if (!key) continue;
        byName.set(key, byName.has(key) && byName.get(key)?.id !== m.id ? null : m);
      }
    }
    return {
      hubOrigin: hub,
      setHubOrigin: (origin) => {
        const clean = httpOrigin(origin);
        if (clean) setHub(clean);
      },
      avatarUrl: ({ userId, username, name }) => {
        if (!hub) return null;
        const found = username || (userId && byId.get(userId)?.username) || (name ? byName.get(fold(name))?.username : undefined);
        return found ? `${hub}/avatar/${encodeURIComponent(found)}` : null;
      },
    };
  }, [hub, members]);

  return <PeopleContext.Provider value={value}>{children}</PeopleContext.Provider>;
}

export function usePeople(): People {
  return useContext(PeopleContext);
}
