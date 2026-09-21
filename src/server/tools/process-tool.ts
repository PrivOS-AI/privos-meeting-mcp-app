/**
 * `meeting_process {roomId, meetingId}` — NEVER accepts a fileId from the
 * client. Discovers `partFileIds` itself by listing the meeting's OWN Files
 * folder and validating each candidate's own metadata (`assertFileInRoom`)
 * before it is ever trusted, then enqueues the background job. Idempotent by
 * `meetingId` (job-repository unique index): queued/processing in flight
 * returns the same job; completed returns the stored result; failed or a
 * stale `processing` resets and re-runs.
 */
import { AppError } from '../../shared/app-error.js';
import { meetingId8 } from '../../shared/meeting-slug.js';
import { AppDbBotClient } from '../hub/app-db-bot-client.js';
import type { PartRef } from '../media/concat-parts.js';
import { listRoomFolderFiles } from '../media/hub-file-download.js';
import { JobRepository } from '../jobs/job-repository.js';
import { runMeetingJob } from '../jobs/meeting-job.js';
import { JOB_TIMEOUT_MS, meetingQueue } from '../jobs/meeting-queue.js';
import { resolveAsyncVendor } from '../stt/stt-provider-registry.js';
import { assertFileInRoom, requireMeetingOwner, requireVerifiedActor } from './authz.js';
import type { AppTool, ToolRuntime } from './registry.js';

/** A `processing` job whose heartbeat is older than 2x the sweep window is treated as dead — same threshold `meeting_status` uses for `stale`. */
const STALE_HEARTBEAT_MS = 20 * 60_000;

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function parseSeq(name: string): number | null {
  const match = /^audio\.part-(\d+)-/.exec(name);
  return match ? Number(match[1]) : null;
}

function isStale(heartbeatAt: string): boolean {
  return Date.now() - new Date(heartbeatAt).getTime() > STALE_HEARTBEAT_MS;
}

async function discoverParts(runtime: ToolRuntime, roomId: string, folderId: string, meetingId: string): Promise<PartRef[]> {
  const files = await listRoomFolderFiles(runtime.agentBotHub, roomId, folderId);
  const digest = meetingId8(meetingId);
  const parts: PartRef[] = [];
  for (const file of files) {
    if (!file.name.startsWith('audio.part-') || !file.name.includes(digest)) continue;
    const seq = parseSeq(file.name);
    if (seq === null) continue;
    await assertFileInRoom(runtime.agentBotHub, file._id, roomId);
    parts.push({ fileId: file._id, seq, name: file.name });
  }
  return parts.sort((a, b) => a.seq - b.seq);
}

export const processTool: AppTool = {
  name: 'meeting_process',
  title: 'Process meeting',
  description: 'Merge recording parts, identify speakers, and produce the meeting transcript with the selected STT provider.',
  inputSchema: {
    type: 'object',
    required: ['roomId', 'meetingId'],
    properties: { roomId: { type: 'string' }, meetingId: { type: 'string' } },
  },
  async execute(args, context, runtime) {
    const actor = requireVerifiedActor(context);
    const roomId = asString(args.roomId);
    const meetingId = asString(args.meetingId);
    if (!roomId || !meetingId) throw new AppError('roomId and meetingId are required.');

    const db = new AppDbBotClient(roomId);
    const meeting = await requireMeetingOwner(db, actor, roomId, meetingId);

    const jobRepo = new JobRepository(db);
    const existing = await jobRepo.findByMeeting(meetingId);
    if (existing) {
      if (existing.status === 'completed') return { jobId: existing.jobId, status: existing.status };
      if (existing.status === 'queued') return { jobId: existing.jobId, status: existing.status };
      if (existing.status === 'processing' && !isStale(existing.heartbeatAt)) {
        return { jobId: existing.jobId, status: existing.status };
      }
      // failed, or a stale processing job — fall through to reset + re-run.
    }

    const folderId = typeof meeting.folderId === 'string' ? meeting.folderId : '';
    if (!folderId) throw new AppError('Meeting has no storage folder yet — cannot process.');
    const parts = await discoverParts(runtime, roomId, folderId, meetingId);
    if (parts.length === 0) throw new AppError('Meeting has no recording parts to process.');

    const asyncVendor = await resolveAsyncVendor(db);
    const sttProvider = asyncVendor === 'elevenlabs' ? ('elevenlabs-batch' as const) : ('soniox-async' as const);

    const job = await jobRepo.claim({
      meetingId,
      roomId,
      partFileIds: parts.map((p) => p.fileId),
      sttProvider,
      language: typeof meeting.language === 'string' && meeting.language ? meeting.language : 'vi',
      title: typeof meeting.title === 'string' ? meeting.title : '',
      keepAudio: meeting.keepAudio !== false,
    });

    void meetingQueue
      .enqueue(meetingId, (signal) => runMeetingJob({ job, roomId, folderId, parts, agentBotHub: runtime.agentBotHub, signal }), JOB_TIMEOUT_MS)
      .catch((error) => {
        console.error('[meeting_process] job failed', { jobId: job.jobId, meetingId, error: error instanceof Error ? error.message : error });
      });

    return { jobId: job.jobId, status: 'queued' };
  },
};
