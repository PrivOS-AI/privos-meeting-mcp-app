/**
 * Upload one recorded part to Files. `duplicateAction:'keep_both'` is the ONLY
 * acceptable value here — `replace` would let two meetings that raced to the
 * same folder overwrite each other's audio (Files upload is an upsert by
 * path). Retry policy lives in `part-upload-queue.ts`; this module is a plain
 * async function with no state of its own.
 */
import { parseToolResult } from '@privos_ai/app-react';
import type { McpApp } from '@privos_ai/app-react';
import { unwrapRestBody } from './rest-body.js';

import { partFileName } from '../../shared/meeting-slug.js';

export { PART_MS } from './media-recorder-service.js';

/**
 * `Blob.arrayBuffer()` + a manual base64 encode — works identically in the
 * browser iframe and in a plain Node test environment (no jsdom / FileReader
 * dependency), using the `btoa` global both runtimes provide.
 */
async function blobToBase64DataUri(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  const base64 = btoa(binary);
  return `data:${blob.type || 'application/octet-stream'};base64,${base64}`;
}

export interface UploadPartInput {
  roomId: string;
  folderId: string;
  meetingId: string;
  seq: number;
  blob: Blob;
}

/** Uploads one part, returning its Files id. Never sends `duplicateAction:'replace'`. */
export async function uploadPart(app: McpApp, input: UploadPartInput): Promise<{ fileId: string }> {
  const base64Data = await blobToBase64DataUri(input.blob);
  const response = await app.uploadFile({
    channelId: input.roomId,
    folderId: input.folderId,
    fileName: partFileName(input.seq, input.meetingId),
    base64Data,
    mimeType: 'audio/webm',
    duplicateAction: 'keep_both',
  });
  const fileId = (response as { file?: { _id?: string } } | undefined)?.file?._id;
  if (!fileId) throw new Error('uploadFile không trả về id của part vừa upload.');
  return { fileId };
}

export interface ChunkReadySegment {
  speaker: string;
  startMs: number;
  endMs: number;
  final: boolean;
}

export interface NotifyChunkReadyInput {
  roomId: string;
  meetingId: string;
  seq: number;
  durationMs: number;
  segments: ChunkReadySegment[];
}

/**
 * Best-effort `meeting_chunk_ready` call after a part upload succeeds. Losing
 * this call only delays live speaker labels — the backend re-derives missed
 * work from `meetings.partCount` (spec) — so a failure here is logged and
 * swallowed rather than retried or allowed to block the next part's upload.
 */
export async function notifyChunkReady(app: McpApp, input: NotifyChunkReadyInput): Promise<void> {
  try {
    const raw = await app.callServerTool({ name: 'meeting_chunk_ready', arguments: input });
    parseToolResult(raw);
  } catch (error) {
    console.warn('meeting_chunk_ready failed (live labels will lag, storage is unaffected):', error);
  }
}

interface FileRecord {
  _id: string;
  name: string;
}

function asFiles(body: unknown): FileRecord[] {
  const files = (body as { files?: unknown })?.files;
  return Array.isArray(files) ? (files as FileRecord[]) : [];
}

/** List every part already uploaded for a meeting's folder, in upload (name) order. */
export async function listParts(app: McpApp, roomId: string, folderId: string): Promise<FileRecord[]> {
  const response = await app.rest({
    method: 'GET',
    path: `file-management.files.channel/${roomId}`,
    query: { folderId, count: 100 },
  });
  return asFiles(unwrapRestBody(response))
    .filter((file) => file.name.startsWith('audio.part-'))
    .sort((a, b) => a.name.localeCompare(b.name));
}
