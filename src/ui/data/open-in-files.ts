/**
 * Open a Files folder of the current room in the Hub.
 *
 * The iframe is sandboxed without `allow-popups`, so `window.open` here does
 * nothing; the host's `OPEN_LINK` request opens the URL from the Hub page
 * instead (a new tab). A relative URL resolves against the Hub's origin.
 *
 * The Hub's Files manager is the room's `files` tab, with the folder id as the
 * route `context`: `/group/<room name>/files/<folderId>` (`/channel/…` for a
 * public room, `/direct/<rid>/…` for a DM). The room type and name come from
 * `rooms.info` (optional `rooms:read`); without it, PrivOS rooms are private
 * groups, so `/group/<host roomName>` is the fallback.
 */
import type { McpApp } from '@privos_ai/app-react';

import { unwrapRestBody } from './rest-body.js';

interface RoomInfo {
  t?: string;
  name?: string;
}

const ROUTE_BY_TYPE: Record<string, string> = { c: 'channel', p: 'group', d: 'direct' };

export function filesFolderPath(room: { type?: string; name?: string; id: string }, folderId: string): string | null {
  const route = ROUTE_BY_TYPE[room.type ?? 'p'] ?? 'group';
  const segment = route === 'direct' ? room.id : room.name;
  if (!segment) return null;
  return `/${route}/${encodeURIComponent(segment)}/files/${encodeURIComponent(folderId)}`;
}

async function roomInfo(app: McpApp, roomId: string): Promise<RoomInfo | null> {
  try {
    const body = unwrapRestBody<{ room?: RoomInfo }>(await app.rest({ method: 'GET', path: 'rooms.info', query: { roomId } }));
    return body.room ?? null;
  } catch {
    return null;
  }
}

/** Resolves `false` when no URL could be built (no room name known). */
export async function openInFiles(app: McpApp, room: { id: string; name?: string }, folderId: string): Promise<boolean> {
  const info = await roomInfo(app, room.id);
  const path = filesFolderPath({ id: room.id, type: info?.t, name: info?.name || room.name }, folderId);
  if (!path) return false;
  window.parent.postMessage({ jsonrpc: '2.0', method: 'OPEN_LINK', params: { url: path } }, '*');
  return true;
}
