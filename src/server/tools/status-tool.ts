/**
 * `meeting_status {roomId, meetingId}` — any room member of the meeting may
 * poll this (not owner-only). Trims the row to exactly what the UI needs:
 * never a temp file path, never a vector, never the vendor's own job id
 * (`providerFileId`/`providerTranscriptionId` stay internal).
 */
import { AppError } from '../../shared/app-error.js';
import { AppDbBotClient } from '../hub/app-db-bot-client.js';
import { JobRepository, STALE_AFTER_MS } from '../jobs/job-repository.js';
import { requireRoomMeeting, requireVerifiedActor } from './authz.js';
import type { AppTool } from './registry.js';

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export const statusTool: AppTool = {
  name: 'meeting_status',
  title: 'Meeting processing status',
  description: 'View meeting processing progress: current step, percent complete, and the result when finished.',
  inputSchema: {
    type: 'object',
    required: ['roomId', 'meetingId'],
    properties: { roomId: { type: 'string' }, meetingId: { type: 'string' } },
  },
  async execute(args, context) {
    const actor = requireVerifiedActor(context);
    const roomId = asString(args.roomId);
    const meetingId = asString(args.meetingId);
    if (!roomId || !meetingId) throw new AppError('roomId and meetingId are required.');

    const db = new AppDbBotClient(roomId);
    await requireRoomMeeting(db, actor, roomId, meetingId);

    const job = await new JobRepository(db).findByMeeting(meetingId);
    if (!job) {
      return { status: 'not_found', step: null, progress: 0, heartbeatAt: null, stale: false };
    }

    const stale = job.status === 'processing' && Date.now() - new Date(job.heartbeatAt).getTime() > STALE_AFTER_MS;
    return {
      status: job.status,
      step: job.step,
      progress: job.progress,
      heartbeatAt: job.heartbeatAt,
      stale,
      provider: job.sttProvider,
      error: job.error,
      result: job.result,
    };
  },
};
