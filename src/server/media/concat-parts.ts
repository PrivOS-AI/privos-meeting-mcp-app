/**
 * Concatenates uploaded audio parts into one local `audio.webm`. Sorts by
 * `seq`, blocks a sequence with a gap, and checks EVERY part matches
 * `processing_jobs.partFileIds` for this exact job (blocks drift between
 * when `meeting_process` discovers the parts and when the job actually
 * runs) + carries the correct `meetingId8` stamp in its name (blocks a part
 * from a different meeting in the same room/day/title leaking in — FM F8 /
 * S2-10). Downloads + concatenates via stream with backpressure, never
 * holding a whole part in RAM.
 */
import { createWriteStream } from 'node:fs';
import { once } from 'node:events';

import type { RoomBoundHubClient } from '@privos_ai/app-server';

import { AppError } from '../../shared/app-error.js';
import { meetingId8 } from '../../shared/meeting-slug.js';
import { deleteRoomFile, fetchFileReadable } from './hub-file-download.js';

export interface PartRef {
  fileId: string;
  seq: number;
  name: string;
}

export async function concatParts(
  hub: RoomBoundHubClient,
  meetingId: string,
  parts: readonly PartRef[],
  jobPartFileIds: readonly string[],
  destPath: string,
  signal: AbortSignal,
): Promise<void> {
  if (parts.length === 0) {
    throw new AppError('Meeting has no recording parts to concatenate.');
  }
  const sorted = [...parts].sort((a, b) => a.seq - b.seq);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].seq === sorted[i - 1].seq) continue;
    if (sorted[i].seq !== sorted[i - 1].seq + 1) {
      throw new AppError(`Recording is missing part #${sorted[i - 1].seq + 1}.`);
    }
  }

  const digest = meetingId8(meetingId);
  const allowed = new Set(jobPartFileIds);
  const dest = createWriteStream(destPath);
  try {
    for (const part of sorted) {
      if (signal.aborted) throw new AppError('Job was cancelled while concatenating recording parts.');
      if (!allowed.has(part.fileId)) {
        throw new AppError(`Recording part "${part.name}" does not match the processing job — aborting concatenation.`);
      }
      if (!part.name.includes(digest)) {
        throw new AppError(`Recording part "${part.name}" does not carry the correct meeting signature — it may belong to a different meeting.`);
      }
      const source = await fetchFileReadable(hub, part.fileId, signal);
      for await (const chunk of source) {
        if (signal.aborted) throw new AppError('Job was cancelled while concatenating recording parts.');
        if (!dest.write(chunk)) await once(dest, 'drain');
      }
    }
  } finally {
    dest.end();
    await once(dest, 'close').catch(() => undefined);
  }
}

/**
 * Deletes exactly the fileIds recorded in `processing_jobs.partFileIds` —
 * NEVER scans the folder. Best-effort per part: a delete failure is logged,
 * not thrown, so one stuck part does not block the rest of the job (a
 * leftover part is harmless clutter; the boot sweep does not need to chase it
 * since only the audio.webm/transcript matter to the finished meeting).
 */
export async function deletePartFiles(hub: RoomBoundHubClient, partFileIds: readonly string[], signal?: AbortSignal): Promise<void> {
  for (const fileId of partFileIds) {
    await deleteRoomFile(hub, fileId, signal).catch((error) => {
      console.warn('[concat-parts] failed to delete part:', fileId, error instanceof Error ? error.message : error);
    });
  }
}
