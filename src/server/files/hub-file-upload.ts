/**
 * Uploads one artifact (`audio.webm`, `transcript.json/.md/.srt`, later
 * `summary.md`) to the meeting's Files folder AS THE INSTALLATION BOT.
 * `data.filePath` streams via `fs.openAsBlob` (Node 20+, lazily opens the
 * file — never buffers a whole meeting's audio in memory); a plain `Buffer`
 * is fine for the small text artifacts. `duplicateAction:'replace'` is only
 * ever used for these named, re-derivable artifacts — NEVER for a part file
 * (those are `keep_both`, guarded by `meetingId8` — see `concat-parts.ts`).
 */
import { openAsBlob } from 'node:fs';

import type { RoomBoundHubClient } from '@privos_ai/app-server';

import { AppError } from '../../shared/app-error.js';

export interface UploadBotFileInput {
  hub: RoomBoundHubClient;
  roomId: string;
  folderId: string;
  fileName: string;
  mimeType: string;
  data: Buffer | { filePath: string };
  duplicateAction: 'replace' | 'keep_both';
  signal?: AbortSignal;
}

export interface UploadBotFileResult {
  fileId: string;
}

const UPLOAD_PATH = '/api/v1/file-management.files.upload';

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function uploadBotFile(input: UploadBotFileInput): Promise<UploadBotFileResult> {
  const blob = Buffer.isBuffer(input.data)
    ? new Blob([input.data], { type: input.mimeType })
    : await openAsBlob(input.data.filePath, { type: input.mimeType });

  const formData = new FormData();
  formData.append('files', blob, input.fileName);
  formData.append('channelId', input.roomId);
  formData.append('folderId', input.folderId);
  formData.append('duplicateAction', input.duplicateAction);

  const response = await input.hub.authorizedFetch(UPLOAD_PATH, {
    method: 'POST',
    body: formData,
    requiredScope: 'files:write',
    signal: input.signal,
  });
  const body = await readJson(response);
  if (!response.ok || body?.success !== true) {
    const message = typeof body?.error === 'string' ? body.error : typeof body?.message === 'string' ? body.message : `HTTP ${response.status}`;
    throw new AppError(`Failed to save file "${input.fileName}" to the room: ${message}`);
  }
  const file = body.file;
  const fileId = file && typeof file === 'object' ? (file as Record<string, unknown>)._id : undefined;
  if (typeof fileId !== 'string' || !fileId) {
    throw new AppError(`Hub did not return a file id after saving "${input.fileName}".`);
  }
  return { fileId };
}
