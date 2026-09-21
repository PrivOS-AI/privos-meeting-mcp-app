/**
 * Retention sweep, single source of configuration = `app_settings` (never an
 * env var — plan.md § cleanup job: "no more MEETING_AUDIO_RETENTION_DAYS env var"):
 *
 *  1. Kept audio past `autoDeleteAudioDays` (default 90, `0` = disabled): a
 *     `summarized` meeting with `keepAudio` whose `endedAt` is old enough and
 *     not yet `audioDeletedAt` gets its `audioFileId` deleted from Files, then
 *     `audioDeletedAt` is stamped — audio of a `keepAudio:false` meeting was
 *     already deleted right after summarization (P3/P6), this only ever
 *     touches audio that was deliberately kept.
 *  2. Orphaned parts of an `interrupted` meeting past
 *     `interruptedPartsRetentionDays` (default 7): every `audio.part-*` file
 *     still in the meeting's folder gets deleted (best-effort per file).
 *  3. `pendingEmbedding` left over on a `meeting_speakers` row whose meeting
 *     ended 30+ days ago and was never confirmed via `speaker_resolve` — the
 *     deferred item from phase-04's risk table ("`meeting_bootstrap` clears
 *     `pendingEmbedding` older than 30 days"). The row keeps its "Speaker N"
 *     label; only the pending biometric ciphertext is cleared.
 *
 * Runs at boot and every 6h across every room in the node-local known-rooms
 * registry (`startAudioRetention`), and per-room from `meeting_bootstrap`
 * (`purgeExpiredAudio`) — same signature convention as `startup-sweep.ts`'s
 * `sweepRoom`/`startupSweep` pair, which this module is a sibling of.
 */
import type { RoomBoundHubClient } from '@privos_ai/app-server';

import { DEFAULT_WORKSPACE_SETTINGS } from '../../shared/app-settings.js';
import { AppDbBotClient, extractDbRecords } from '../hub/app-db-bot-client.js';
import { getSetting } from '../hub/app-settings.js';
import { deleteRoomFile, listRoomFolderFiles } from '../media/hub-file-download.js';
import { readKnownRooms } from './known-rooms-store.js';

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const PENDING_EMBEDDING_TTL_DAYS = 30;

export interface RetentionSummary {
  audioDeleted: number;
  orphanPartsDeleted: number;
  pendingEmbeddingsCleared: number;
}

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

/** Kept audio past `autoDeleteAudioDays` — `days <= 0` disables this branch entirely. */
async function purgeKeptAudio(hub: RoomBoundHubClient, roomId: string, days: number): Promise<number> {
  if (days <= 0) return 0;
  const db = new AppDbBotClient(roomId);
  const result = await db.query('meetings', 'room', {
    where: [
      { field: 'status', op: '==', value: 'summarized' },
      { field: 'keepAudio', op: '==', value: true },
      { field: 'endedAt', op: '<', value: daysAgoIso(days) },
    ],
    limit: 1000,
  });
  let deleted = 0;
  for (const meeting of extractDbRecords(result)) {
    if (typeof meeting.audioDeletedAt === 'string' && meeting.audioDeletedAt) continue;
    const audioFileId = typeof meeting.audioFileId === 'string' ? meeting.audioFileId : '';
    if (!audioFileId) continue;
    try {
      await deleteRoomFile(hub, audioFileId);
      await db.update('meetings', 'room', meeting._id, { audioDeletedAt: new Date().toISOString() });
      deleted++;
    } catch (error) {
      console.warn('[audio-retention-job] failed to delete audio:', meeting._id, error instanceof Error ? error.message : error);
    }
  }
  return deleted;
}

/** Orphaned parts of a meeting `interrupted` for longer than `interruptedPartsRetentionDays` — `days <= 0` disables this branch. */
async function purgeInterruptedParts(hub: RoomBoundHubClient, roomId: string, days: number): Promise<number> {
  if (days <= 0) return 0;
  const db = new AppDbBotClient(roomId);
  const result = await db.query('meetings', 'room', {
    where: [
      { field: 'status', op: '==', value: 'interrupted' },
      { field: 'lastPartAt', op: '<', value: daysAgoIso(days) },
    ],
    limit: 1000,
  });
  let deleted = 0;
  for (const meeting of extractDbRecords(result)) {
    const folderId = typeof meeting.folderId === 'string' ? meeting.folderId : '';
    if (!folderId) continue;
    const files = await listRoomFolderFiles(hub, roomId, folderId).catch(() => []);
    for (const file of files) {
      if (!file.name.startsWith('audio.part-')) continue;
      await deleteRoomFile(hub, file._id)
        .then(() => deleted++)
        .catch((error) => console.warn('[audio-retention-job] failed to delete orphaned part:', file._id, error instanceof Error ? error.message : error));
    }
  }
  return deleted;
}

/** `pendingEmbedding` on rows whose meeting ended 30+ days ago and was never resolved. */
async function purgeStalePendingEmbeddings(roomId: string): Promise<number> {
  const db = new AppDbBotClient(roomId);
  const meetingsResult = await db.query('meetings', 'room', {
    where: [{ field: 'endedAt', op: '<', value: daysAgoIso(PENDING_EMBEDDING_TTL_DAYS) }],
    limit: 1000,
  });
  const staleMeetingIds = extractDbRecords(meetingsResult).map((m) => m._id);
  let cleared = 0;
  for (const meetingId of staleMeetingIds) {
    const speakersResult = await db.query('meeting_speakers', 'room', {
      where: [{ field: 'meeting', op: '==', value: meetingId }],
      limit: 1000,
    });
    for (const row of extractDbRecords(speakersResult)) {
      if (typeof row.pendingEmbedding !== 'string' || !row.pendingEmbedding) continue;
      await db
        .update('meeting_speakers', 'room', row._id, { pendingEmbedding: '' })
        .then(() => cleared++)
        .catch((error) => console.warn('[audio-retention-job] failed to clear pendingEmbedding:', row._id, error instanceof Error ? error.message : error));
    }
  }
  return cleared;
}

/** One room's full retention sweep — called by `meeting_bootstrap` for the room it just opened, and by `startAudioRetention`'s interval for every known room. */
export async function purgeExpiredAudio(hub: RoomBoundHubClient, roomId: string): Promise<RetentionSummary> {
  // Global `app_settings` reads carry this room's id so they resolve to the granted `room` permission context (see AppDbBotClient).
  const settingsDb = new AppDbBotClient(roomId);
  const autoDeleteAudioDays = (await getSetting<number>(settingsDb, 'autoDeleteAudioDays')) ?? DEFAULT_WORKSPACE_SETTINGS.autoDeleteAudioDays;
  const interruptedPartsRetentionDays =
    (await getSetting<number>(settingsDb, 'interruptedPartsRetentionDays')) ?? DEFAULT_WORKSPACE_SETTINGS.interruptedPartsRetentionDays;

  const audioDeleted = await purgeKeptAudio(hub, roomId, autoDeleteAudioDays);
  const orphanPartsDeleted = await purgeInterruptedParts(hub, roomId, interruptedPartsRetentionDays);
  const pendingEmbeddingsCleared = await purgeStalePendingEmbeddings(roomId).catch((error) => {
    console.warn('[audio-retention-job] purgeStalePendingEmbeddings failed:', roomId, error instanceof Error ? error.message : error);
    return 0;
  });

  return { audioDeleted, orphanPartsDeleted, pendingEmbeddingsCleared };
}

async function sweepAllKnownRooms(hub: RoomBoundHubClient): Promise<void> {
  const knownRooms = await readKnownRooms();
  for (const roomId of knownRooms) {
    await purgeExpiredAudio(hub, roomId).catch((error) => {
      console.warn('[audio-retention-job] room sweep failed:', roomId, error instanceof Error ? error.message : error);
    });
  }
}

/** Runs the sweep immediately (boot) then every 6h across `knownRooms`. Returns a stop function for graceful shutdown. */
export function startAudioRetention(hub: RoomBoundHubClient): () => void {
  void sweepAllKnownRooms(hub).catch((error) => {
    console.warn('[audio-retention-job] boot sweep failed:', error instanceof Error ? error.message : error);
  });
  const timer = setInterval(() => {
    void sweepAllKnownRooms(hub).catch((error) => {
      console.warn('[audio-retention-job] interval sweep failed:', error instanceof Error ? error.message : error);
    });
  }, SIX_HOURS_MS);
  timer.unref();
  return () => clearInterval(timer);
}
