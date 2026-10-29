/**
 * Finds or creates a folder path in a Room's Files AS THE INSTALLATION BOT —
 * the server-side twin of the iframe's `ui/data/meeting-folder.ts`, for a
 * meeting the server starts itself (`meeting_listen_start`, called by the
 * Room's agent with no app tab open). Same rules: reuse a same-name sibling
 * (the Hub refuses a duplicate), and re-list after a lost create race.
 */
import type { RoomBoundHubClient } from '@privos_ai/app-server';

import { AppError } from '../../shared/app-error.js';

interface FolderRecord {
  _id: string;
  name: string;
}

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function listFolders(hub: RoomBoundHubClient, roomId: string, fatherId: string | undefined): Promise<FolderRecord[]> {
  const query = new URLSearchParams({ count: '100', ...(fatherId ? { fatherId } : {}) });
  const response = await hub.authorizedFetch(`/api/v1/file-management.folders.channel/${encodeURIComponent(roomId)}?${query}`, { method: 'GET', requiredScope: 'files:read' });
  const body = await readJson(response);
  if (!response.ok) throw new AppError(`Could not list the room's folders (HTTP ${response.status}).`, 'HUB_ERROR');
  const folders = body?.folders;
  return Array.isArray(folders) ? folders.filter((f): f is FolderRecord => typeof f?._id === 'string' && typeof f?.name === 'string') : [];
}

async function findOrCreateFolder(hub: RoomBoundHubClient, roomId: string, name: string, fatherId: string | undefined): Promise<string> {
  const existing = (await listFolders(hub, roomId, fatherId)).find((folder) => folder.name === name);
  if (existing) return existing._id;
  const response = await hub.authorizedFetch('/api/v1/file-management.folders.create', {
    method: 'POST',
    requiredScope: 'files:write',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, channelId: roomId, ...(fatherId ? { fatherId } : {}) }),
  });
  const body = await readJson(response);
  const folder = body?.folder as FolderRecord | undefined;
  if (response.ok && folder?._id) return folder._id;
  const raced = (await listFolders(hub, roomId, fatherId)).find((f) => f.name === name);
  if (raced) return raced._id;
  throw new AppError(`Failed to create folder "${name}" in Files (HTTP ${response.status}).`, 'HUB_ERROR');
}

/** The deepest folder's id of `folderPath` (e.g. `Meetings/2026-10-29-standup-ab12cd34`), creating what is missing. */
export async function ensureRoomFolderPath(hub: RoomBoundHubClient, roomId: string, folderPath: string): Promise<string> {
  let fatherId: string | undefined;
  for (const name of folderPath.split('/').filter(Boolean)) fatherId = await findOrCreateFolder(hub, roomId, name, fatherId);
  if (!fatherId) throw new AppError('Empty folder path.', 'INVALID_INPUT');
  return fatherId;
}
