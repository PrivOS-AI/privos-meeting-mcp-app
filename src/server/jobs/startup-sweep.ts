/**
 * Boot + `meeting_bootstrap` sweep, one room at a time: reloads `queued` jobs
 * into the run queue, fails `processing` jobs whose heartbeat has gone stale
 * (pm2 restart mid-job -> `failed(interrupted)`), marks a meeting stuck in
 * `recording` with no recent part as `interrupted`, and best-effort deletes a
 * dead Soniox job's own remote file/transcription using the ids THIS APP
 * already persisted (`processing_jobs.providerFileId`/`providerTranscriptionId`)
 * — never a live "list by client_reference_id" vendor call, which is not a
 * documented Soniox endpoint (open question #2).
 */
import type { RoomBoundHubClient } from '@privos_ai/app-server';

import { meetingId8 } from '../../shared/meeting-slug.js';
import { AppDbBotClient, extractDbRecords } from '../hub/app-db-bot-client.js';
import { getSetting } from '../hub/app-settings.js';
import { env } from '../env.js';
import type { PartRef } from '../media/concat-parts.js';
import { listRoomFolderFiles } from '../media/hub-file-download.js';
import { JobRepository, type JobRecord } from './job-repository.js';
import { runMeetingJob } from './meeting-job.js';
import { JOB_TIMEOUT_MS, meetingQueue } from './meeting-queue.js';

const STALE_JOB_MS = 10 * 60_000;
const ABANDONED_MEETING_MS = 10 * 60_000;
const SONIOX_CLEANUP_TIMEOUT_MS = 15_000;

function parseSeq(name: string): number | null {
  const match = /^audio\.part-(\d+)-/.exec(name);
  return match ? Number(match[1]) : null;
}

/** Rebuilds the `PartRef[]` a re-queued job needs from its OWN persisted `partFileIds` + the current folder listing. */
async function partsForJob(hub: RoomBoundHubClient, roomId: string, folderId: string, job: JobRecord): Promise<PartRef[]> {
  const files = await listRoomFolderFiles(hub, roomId, folderId);
  const digest = meetingId8(job.meetingId);
  const allowed = new Set(job.partFileIds);
  const parts: PartRef[] = [];
  for (const file of files) {
    if (!allowed.has(file._id) || !file.name.includes(digest)) continue;
    const seq = parseSeq(file.name);
    if (seq === null) continue;
    parts.push({ fileId: file._id, seq, name: file.name });
  }
  return parts.sort((a, b) => a.seq - b.seq);
}

async function requeueJob(hub: RoomBoundHubClient, roomId: string, job: JobRecord): Promise<void> {
  const roomDb = new AppDbBotClient(roomId);
  const meeting = await roomDb.getById('meetings', 'room', job.meetingId);
  const folderId = typeof meeting?.folderId === 'string' ? meeting.folderId : undefined;
  if (!folderId) return;
  const parts = await partsForJob(hub, roomId, folderId, job);
  if (parts.length === 0) return;
  void meetingQueue
    .enqueue(job.meetingId, (signal) => runMeetingJob({ job, roomId, folderId, parts, agentBotHub: hub, signal }), JOB_TIMEOUT_MS)
    .catch((error) => {
      console.error('[startup-sweep] requeued job failed', {
        jobId: job.jobId,
        meetingId: job.meetingId,
        error: error instanceof Error ? error.message : error,
      });
    });
}

interface SonioxCleanupTarget {
  sttProvider?: unknown;
  providerFileId?: unknown;
  providerTranscriptionId?: unknown;
  [key: string]: unknown;
}

/** Best-effort remote cleanup for a dead soniox-async job — never throws, never invents a vendor lookup endpoint. */
async function cleanupDeadSonioxJob(job: SonioxCleanupTarget): Promise<void> {
  if (job.sttProvider !== 'soniox-async' || !env.sonioxApiKey) return;
  const providerFileId = typeof job.providerFileId === 'string' ? job.providerFileId : undefined;
  const providerTranscriptionId = typeof job.providerTranscriptionId === 'string' ? job.providerTranscriptionId : undefined;
  if (!providerFileId && !providerTranscriptionId) return;

  const headers = { authorization: `Bearer ${env.sonioxApiKey}` };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SONIOX_CLEANUP_TIMEOUT_MS);
  try {
    if (providerTranscriptionId) {
      await fetch(`https://api.soniox.com/v1/transcriptions/${encodeURIComponent(providerTranscriptionId)}`, {
        method: 'DELETE',
        headers,
        signal: controller.signal,
      }).catch(() => undefined);
    }
    if (providerFileId) {
      await fetch(`https://api.soniox.com/v1/files/${encodeURIComponent(providerFileId)}`, {
        method: 'DELETE',
        headers,
        signal: controller.signal,
      }).catch(() => undefined);
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Sweeps ONE room — used both by the boot-time `startupSweep` loop and directly by `meeting_bootstrap` for the room it just opened. */
export async function sweepRoom(hub: RoomBoundHubClient, roomId: string): Promise<void> {
  const db = new AppDbBotClient(roomId);
  const jobRepo = new JobRepository(db);

  const queued = await jobRepo.listQueued();
  for (const job of queued) await requeueJob(hub, roomId, job);

  const stale = await jobRepo.sweepStale(STALE_JOB_MS);
  for (const job of stale) await cleanupDeadSonioxJob({ ...job });

  const cutoffIso = new Date(Date.now() - ABANDONED_MEETING_MS).toISOString();
  const abandoned = await db.query('meetings', 'room', {
    where: [
      { field: 'status', op: '==', value: 'recording' },
      { field: 'lastPartAt', op: '<', value: cutoffIso },
    ],
    limit: 1000,
  });
  for (const meeting of extractDbRecords(abandoned)) {
    await db.update('meetings', 'room', meeting._id, { status: 'interrupted' }).catch(() => undefined);
  }

  // Jobs that were ALREADY `failed` before this boot (e.g. a hard crash before
  // their own `finally` ran) — sweep their remote garbage too.
  const failed = await db.query('processing_jobs', 'room', { where: [{ field: 'status', op: '==', value: 'failed' }], limit: 1000 });
  for (const row of extractDbRecords(failed)) await cleanupDeadSonioxJob(row);
}

/** `knownRooms` (`app_settings`, global) -> sweep each room. Called at boot and again from `meeting_bootstrap`. */
export async function startupSweep(hub: RoomBoundHubClient): Promise<void> {
  const globalDb = new AppDbBotClient();
  const knownRooms = (await getSetting<string[]>(globalDb, 'knownRooms')) ?? [];
  for (const roomId of knownRooms) {
    await sweepRoom(hub, roomId).catch((error) => {
      console.error('[startup-sweep] room sweep failed', { roomId, error: error instanceof Error ? error.message : error });
    });
  }
}
