/**
 * Find-or-create the meeting's Files folder, idempotent by name. Two calls
 * with the same path always resolve to the same folder id — safe to call every
 * time a meeting starts without tracking whether it was already created.
 *
 * Path is always `Meetings/<folderName>` where `folderName` already carries
 * the 8-char `meetingId8` (see `shared/meeting-slug.ts`), so two same-day
 * same-title meetings never collide on a folder.
 */
import type { McpApp } from '@privos_ai/app-react';

interface FolderRecord {
  _id: string;
  name: string;
}

function asFolders(body: unknown): FolderRecord[] {
  const folders = (body as { folders?: unknown })?.folders;
  return Array.isArray(folders) ? (folders as FolderRecord[]) : [];
}

async function findOrCreateFolder(app: McpApp, roomId: string, name: string, fatherId: string | undefined): Promise<string> {
  const listed = await app.rest({
    method: 'GET',
    path: `file-management.folders.channel/${roomId}`,
    query: fatherId ? { fatherId, count: 100 } : { count: 100 },
  });
  const existing = asFolders(listed.body).find((folder) => folder.name === name);
  if (existing) return existing._id;

  const created = await app.rest({
    method: 'POST',
    path: 'file-management.folders.create',
    body: { name, channelId: roomId, ...(fatherId ? { fatherId } : {}) },
  });
  const folder = (created.body as { folder?: FolderRecord })?.folder;
  if (!folder?._id) throw new Error('file-management.folders.create trả về dữ liệu không hợp lệ.');
  return folder._id;
}

/**
 * Resolve (creating as needed) every path segment of `folderPath`, returning
 * the deepest folder's id. `folderPath` is expected to already be the full
 * relative path (e.g. `shared/meeting-slug.ts`'s `folderName()`, which starts
 * with `Meetings/`) — this function does not add a prefix of its own.
 */
export async function ensureMeetingFolder(app: McpApp, roomId: string, folderPath: string): Promise<string> {
  const segments = folderPath.split('/').filter(Boolean);
  let fatherId: string | undefined;
  for (const name of segments) {
    fatherId = await findOrCreateFolder(app, roomId, name, fatherId);
  }
  if (!fatherId) throw new Error('ensureMeetingFolder: empty folder path.');
  return fatherId;
}
