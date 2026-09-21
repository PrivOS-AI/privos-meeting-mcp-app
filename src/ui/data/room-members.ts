/**
 * Search the current room's members for the "Confirm speaker" modal's
 * member picker. Uses the Hub's `channels.members` route (the app's
 * OPTIONAL `rooms:read` grant) — same pattern as the genealogy app's
 * `room-members.ts`. A caller without the grant sees `success:false` or a
 * thrown/timed-out request; `member-picker.tsx` degrades to free-text entry
 * in that case (manifest `degradedBehavior`).
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

function toMember(m: RawMember): RoomMember {
  return { id: m._id ?? '', username: m.username ?? '', name: m.name || m.username || '' };
}

/** Guards `app.rest` with an 8s timeout — a hung relay round-trip must degrade the picker, not spin forever. */
async function restWithTimeout(app: McpApp, query: Record<string, string | number | boolean>): Promise<MembersEnvelope> {
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('channels.members timed out')), SEARCH_TIMEOUT_MS));
  const res = (await Promise.race([app.rest({ method: 'GET', path: 'channels.members', query }), timeout])) as { body?: MembersEnvelope } & MembersEnvelope;
  return (res?.body ?? res ?? {}) as MembersEnvelope;
}

export async function searchRoomMembers(app: McpApp, roomId: string, filter: string, count = 10): Promise<RoomMember[]> {
  const body = await restWithTimeout(app, { roomId, filter: filter.trim(), count });
  if (body.success === false) throw new Error(body.error || body.message || 'channels.members failed');
  const members = body.members ?? body.data?.members ?? [];
  return members.map(toMember).filter((m) => m.id !== '');
}
