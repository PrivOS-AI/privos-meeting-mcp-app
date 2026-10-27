/**
 * File access to Room Files AS THE INSTALLATION BOT: metadata lookup (backs
 * `authz.ts`'s `assertFileInRoom` confused-deputy guard), folder listing (lets
 * `meeting_process` rediscover a meeting's uploaded parts itself instead of
 * trusting a client-supplied fileId list), a streamed read (concat-parts.ts
 * appends each part to the concatenated `audio.webm` without ever holding a
 * whole part in memory) and delete (parts + a dead job's own artifacts).
 */
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

import type { RoomBoundHubClient } from '@privos_ai/app-server';

import { AppError } from '../../shared/app-error.js';
import { manifest } from '../manifest.js';

export interface RoomFileMeta {
  _id: string;
  name: string;
  channel_id: string;
  folder_id: string | null;
}

function fileMetaPath(fileId: string): string {
  return `/api/v1/file-management.files/${encodeURIComponent(fileId)}`;
}

function fileDownloadPath(fileId: string): string {
  return `/api/v1/file-management.files/${encodeURIComponent(fileId)}/download`;
}

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function asFileMeta(value: unknown): RoomFileMeta | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (typeof record._id !== 'string' || typeof record.name !== 'string' || typeof record.channel_id !== 'string') return null;
  return { _id: record._id, name: record.name, channel_id: record.channel_id, folder_id: typeof record.folder_id === 'string' ? record.folder_id : null };
}

/** The Files API refuses a bot that is not a member of the room with this message. */
export function isBotNotInRoomFileError(message: string | undefined): boolean {
  return Boolean(message?.includes('Not authorized to access this channel'));
}

/** Same code and details as the App Platform path (`bot-tool-call.ts`), so the UI offers one fix: add the bot. */
export function botNotInRoomFileError(): AppError {
  return new AppError('The Meeting Agent bot has not been added to this room. Add the bot to the room and try again.', 'ASSISTANT_NOT_IN_ROOM', {
    scope: 'files:read',
    botSlug: manifest.agentBot.slug,
  });
}

function mapFileHttpError(status: number, body: Record<string, unknown> | null): AppError {
  const message = typeof body?.error === 'string' ? body.error : typeof body?.message === 'string' ? body.message : undefined;
  if (isBotNotInRoomFileError(message)) {
    return botNotInRoomFileError();
  }
  return new AppError(`Could not access the file in the room (HTTP ${status}): ${message ?? 'Unknown error from Hub.'}`, 'HUB_ERROR');
}

/** One file's own metadata, or `null` when it does not exist. Never throws on a plain 404. */
export async function getFileMetadata(hub: RoomBoundHubClient, fileId: string, signal?: AbortSignal): Promise<RoomFileMeta | null> {
  const response = await hub.authorizedFetch(fileMetaPath(fileId), { method: 'GET', requiredScope: 'files:read', signal });
  if (response.status === 404) return null;
  const body = await readJson(response);
  if (!response.ok || body?.success !== true) throw mapFileHttpError(response.status, body);
  // The Hub returns the file record FLAT (`{_id, name, channel_id, …, success}`), not
  // wrapped in `file` — reading only `body.file` made every lookup a miss, so
  // `assertFileInRoom` rejected every part. Accept both shapes.
  return asFileMeta(body.file ?? body);
}

/** Every file directly inside `folderId` — used to rediscover a meeting's own uploaded parts server-side. */
export async function listRoomFolderFiles(
  hub: RoomBoundHubClient,
  roomId: string,
  folderId: string,
  signal?: AbortSignal,
): Promise<RoomFileMeta[]> {
  const path = `/api/v1/file-management.files.channel/${encodeURIComponent(roomId)}?folderId=${encodeURIComponent(folderId)}&count=100`;
  const response = await hub.authorizedFetch(path, { method: 'GET', requiredScope: 'files:read', signal });
  const body = await readJson(response);
  if (!response.ok || body?.success !== true) throw mapFileHttpError(response.status, body);
  const files = Array.isArray(body.files) ? body.files : [];
  return files.map(asFileMeta).filter((f): f is RoomFileMeta => f !== null);
}

/** A file's bytes as a Node `Readable`, streamed straight from the Hub response — never buffered whole. */
export async function fetchFileReadable(hub: RoomBoundHubClient, fileId: string, signal?: AbortSignal): Promise<Readable> {
  const response = await hub.authorizedFetch(fileDownloadPath(fileId), { method: 'GET', requiredScope: 'files:read', signal });
  if (!response.ok || !response.body) {
    throw new AppError(`Could not download file ${fileId} from Files (HTTP ${response.status}).`, 'HUB_ERROR');
  }
  // `Response.body` is a DOM `ReadableStream`; `Readable.fromWeb` expects Node's `stream/web` type
  // of the same shape. The two are structurally identical (WHATWG streams) — safe cast, no data loss.
  return Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
}

/** Streams a whole file to `destPath` on local disk. */
export async function downloadRoomFile(hub: RoomBoundHubClient, fileId: string, destPath: string, signal?: AbortSignal): Promise<void> {
  const source = await fetchFileReadable(hub, fileId, signal);
  // `pipeline` reads a trailing `undefined` as a stream, so the options go in only with a signal.
  if (signal) await pipeline(source, createWriteStream(destPath), { signal });
  else await pipeline(source, createWriteStream(destPath));
}

/** Deletes one file. Throws on failure — callers that consider this best-effort (part/audio cleanup) must catch. */
export async function deleteRoomFile(hub: RoomBoundHubClient, fileId: string, signal?: AbortSignal): Promise<void> {
  const response = await hub.authorizedFetch(fileMetaPath(fileId), { method: 'DELETE', requiredScope: 'files:write', signal });
  if (response.status === 404) return; // already gone — treat as success.
  const body = await readJson(response);
  if (!response.ok || body?.success !== true) throw mapFileHttpError(response.status, body);
}
