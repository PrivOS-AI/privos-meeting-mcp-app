/**
 * Retention sweep, single source of configuration = `app_settings` (never an
 * env var — plan.md § cleanup job: "no more MEETING_AUDIO_RETENTION_DAYS env var"):
 *
 *  1. Remaining audio past `autoDeleteAudioDays` (default 90, `0` = disabled): a
 *     `summarized` meeting whose `endedAt` is old enough and not yet
 *     `audioDeletedAt` gets its `audioFileId` deleted from Files, then
 *     `audioDeletedAt` is stamped. That covers audio kept on purpose
 *     (`keepOriginalAudio`) and audio of a `keepAudio:false` meeting the job
 *     could not delete because its summary failed, which would otherwise
 *     stay forever.
 *  2. Orphaned parts of an `interrupted` meeting past
 *     `interruptedPartsRetentionDays` (default 7): every `audio.part-*` file
 *     still in the meeting's folder gets deleted (best-effort per file).
 *  3. Whole meetings past `autoDeleteMeetingsDays` (default 0 = keep forever): a
 *     `summarized` or `failed` meeting whose `endedAt` is old enough loses its
 *     voice samples, every file in its folder, then its row (children cascade).
 *     A meeting whose files could not all be deleted keeps its row, so the next
 *     sweep retries instead of leaving files nothing points to.
 *  4. `pendingEmbedding` left over on a `meeting_speakers` row whose meeting
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
import { forgetMeetingVoiceprints } from '../speaker/profile-store.js';
import { sweepLocal } from '../speaker/speaker-diagnostics-log.js';
import { readKnownRooms } from './known-rooms-store.js';

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const PENDING_EMBEDDING_TTL_DAYS = 30;

export interface RetentionSummary {
  audioDeleted: number;
  orphanPartsDeleted: number;
  meetingsDeleted: number;
  pendingEmbeddingsCleared: number;
}

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

/** Remaining audio past `autoDeleteAudioDays`, kept or left behind by a failed summary — `days <= 0` disables this branch entirely. */
async function purgeKeptAudio(hub: RoomBoundHubClient, roomId: string, days: number): Promise<number> {
  if (days <= 0) return 0;
  const db = new AppDbBotClient(roomId);
  const result = await db.query('meetings', 'room', {
    where: [
      { field: 'status', op: '==', value: 'summarized' },
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

/** Whole meetings past `autoDeleteMeetingsDays` — `days <= 0` (the default) disables this branch. */
async function purgeExpiredMeetings(hub: RoomBoundHubClient, roomId: string, days: number): Promise<number> {
  if (days <= 0) return 0;
  const db = new AppDbBotClient(roomId);
  const cutoff = daysAgoIso(days);
  const expired = [];
  for (const status of ['summarized', 'failed']) {
    const result = await db.query('meetings', 'room', {
      where: [
        { field: 'status', op: '==', value: status },
        { field: 'endedAt', op: '<', value: cutoff },
      ],
      limit: 1000,
    });
    expired.push(...extractDbRecords(result));
  }
  let deleted = 0;
  for (const meeting of expired) {
    try {
      await forgetMeetingVoiceprints(db, meeting._id);
      const folderId = typeof meeting.folderId === 'string' ? meeting.folderId : '';
      if (folderId) {
        for (const file of await listRoomFolderFiles(hub, roomId, folderId)) await deleteRoomFile(hub, file._id);
      }
      await db.delete('meetings', 'room', meeting._id);
      deleted++;
    } catch (error) {
      console.warn('[audio-retention-job] failed to delete expired meeting (retried next sweep):', meeting._id, error instanceof Error ? error.message : error);
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

  const autoDeleteMeetingsDays = (await getSetting<number>(settingsDb, 'autoDeleteMeetingsDays')) ?? DEFAULT_WORKSPACE_SETTINGS.autoDeleteMeetingsDays;

  // Whole meetings first: their audio goes with them, so the audio branch skips them.
  const meetingsDeleted = await purgeExpiredMeetings(hub, roomId, autoDeleteMeetingsDays);
  const audioDeleted = await purgeKeptAudio(hub, roomId, autoDeleteAudioDays);
  const orphanPartsDeleted = await purgeInterruptedParts(hub, roomId, interruptedPartsRetentionDays);
  const pendingEmbeddingsCleared = await purgeStalePendingEmbeddings(roomId).catch((error) => {
    console.warn('[audio-retention-job] purgeStalePendingEmbeddings failed:', roomId, error instanceof Error ? error.message : error);
    return 0;
  });

  return { audioDeleted, orphanPartsDeleted, meetingsDeleted, pendingEmbeddingsCleared };
}

/** Exported for tests — the boot + 6h interval both go through this. */
export async function sweepAllKnownRooms(hub: RoomBoundHubClient): Promise<void> {
  const knownRooms = await readKnownRooms();
  for (const roomId of knownRooms) {
    await purgeExpiredAudio(hub, roomId).catch((error) => {
      console.warn('[audio-retention-job] room sweep failed:', roomId, error instanceof Error ? error.message : error);
    });
  }
  // Node-local (`data/diagnostics`), not per-room — one sweep per cycle regardless of `knownRooms.length`.
  await sweepLocal().catch((error) => {
    console.warn('[audio-retention-job] local diagnostics sweep failed:', error instanceof Error ? error.message : error);
  });
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
