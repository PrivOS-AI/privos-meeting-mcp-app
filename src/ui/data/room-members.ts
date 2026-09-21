/**
 * Search the current room's members for the "Confirm speaker" modal's
 * member picker. PrivOS rooms are Rocket.Chat PRIVATE GROUPS, so the member
 * list lives on `groups.members` — `channels.members` rejects a private group
 * (see `server/tools/can-manage-room-settings.ts`). We try `groups.members`
 * first and fall back to `channels.members` for the rare public-channel room,
 * caching whichever route the room answers on so later keystrokes make a single
 * round-trip. All of this rides the app's OPTIONAL `rooms:read` grant; when the
 * grant is missing (both routes reject) the call throws and `member-picker.tsx`
 * degrades to free-text entry (manifest `degradedBehavior`).
 */
import type { McpApp } from '@privos_ai/app-react';

export interface RoomMember {
  id: string;
  username: string;
  /** Display name; falls back to the username when unset. */
  name: string;
}

interface RawMember {
  _id?: string;
  username?: string;
  name?: string;
}

interface MembersEnvelope {
  success?: boolean;
  error?: string;
  message?: string;
  members?: RawMember[];
  data?: { members?: RawMember[] };
}

const SEARCH_TIMEOUT_MS = 8000;

/** Private groups first (the norm here), public channels second. */
const MEMBER_ROUTES = ['groups.members', 'channels.members'] as const;
type MemberRoute = (typeof MEMBER_ROUTES)[number];

/** The route a given room answered on, so we skip the wrong one after the first hit. */
const routeByRoom = new Map<string, MemberRoute>();

function toMember(m: RawMember): RoomMember {
  return { id: m._id ?? '', username: m.username ?? '', name: m.name || m.username || '' };
}

/** Guards `app.rest` with an 8s timeout — a hung relay round-trip must degrade the picker, not spin forever. */
async function restWithTimeout(app: McpApp, path: MemberRoute, query: Record<string, string | number | boolean>): Promise<MembersEnvelope> {
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${path} timed out`)), SEARCH_TIMEOUT_MS));
  const res = (await Promise.race([app.rest({ method: 'GET', path, query }), timeout])) as { body?: MembersEnvelope } & MembersEnvelope;
  return (res?.body ?? res ?? {}) as MembersEnvelope;
}

/** One route attempt: members on success, `null` when the room rejects this route (wrong type / no access) or the call fails. */
async function fetchVia(app: McpApp, path: MemberRoute, query: Record<string, string | number | boolean>): Promise<RoomMember[] | null> {
  try {
    const body = await restWithTimeout(app, path, query);
    if (body.success === false) return null;
    const members = body.members ?? body.data?.members ?? [];
    return members.map(toMember).filter((m) => m.id !== '');
  } catch {
    return null;
  }
}

export async function searchRoomMembers(app: McpApp, roomId: string, filter: string, count = 10): Promise<RoomMember[]> {
  const query = { roomId, filter: filter.trim(), count };
  const cached = routeByRoom.get(roomId);
  const routes = cached ? [cached] : MEMBER_ROUTES;
  for (const path of routes) {
    const members = await fetchVia(app, path, query);
    if (members) {
      routeByRoom.set(roomId, path);
      return members;
    }
  }
  throw new Error('room members lookup failed');
}
