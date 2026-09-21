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

import { unwrapRestBody } from './rest-body.js';

interface FolderRecord {
  _id: string;
  name: string;
}

function asFolders(body: unknown): FolderRecord[] {
  const folders = (body as { folders?: unknown })?.folders;
  return Array.isArray(folders) ? (folders as FolderRecord[]) : [];
}

async function listFolders(app: McpApp, roomId: string, fatherId: string | undefined): Promise<FolderRecord[]> {
  const listed = await app.rest({
    method: 'GET',
    path: `file-management.folders.channel/${roomId}`,
    query: fatherId ? { fatherId, count: 100 } : { count: 100 },
  });
  return asFolders(unwrapRestBody(listed));
}

async function findOrCreateFolder(app: McpApp, roomId: string, name: string, fatherId: string | undefined): Promise<string> {
  // Existence check first: the Hub rejects a same-name sibling with
  // DUPLICATE_FOLDER, so an existing folder must be reused, never re-created.
  const existing = (await listFolders(app, roomId, fatherId)).find((folder) => folder.name === name);
  if (existing) return existing._id;

  try {
    const created = await app.rest({
      method: 'POST',
      path: 'file-management.folders.create',
      body: { name, channelId: roomId, ...(fatherId ? { fatherId } : {}) },
    });
    const folder = unwrapRestBody<{ folder?: FolderRecord }>(created).folder;
    if (folder?._id) return folder._id;
  } catch (error) {
    // Lost a create race (another tab/device, or a retry after a half-finished
    // start): the folder exists now — fall through to the re-list below.
    if (!(error instanceof Error) || !error.message.includes('DUPLICATE_FOLDER')) throw error;
  }

  const raced = (await listFolders(app, roomId, fatherId)).find((folder) => folder.name === name);
  if (raced) return raced._id;
  throw new Error(`Failed to create folder "${name}" in Files.`);
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
