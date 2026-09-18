/**
 * `meeting_summarize {roomId, meetingId}` — re-runs ONLY the summary step
 * from the already-written `transcript.json`, without re-transcribing. Real
 * logic (Hub AI summary + translation, writing `summary.md`) lands in P6;
 * this phase ships the authorized, validated shell so the tool exists in the
 * manifest and the UI can wire its button now.
 */
import { AppError } from '../../shared/app-error.js';
import { AppDbBotClient } from '../hub/app-db-bot-client.js';
import { requireMeetingOwner, requireVerifiedActor } from './authz.js';
import type { AppTool } from './registry.js';

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export const summarizeTool: AppTool = {
  name: 'meeting_summarize',
  title: 'Tóm tắt lại cuộc họp',
  description: 'Chạy lại riêng bước tóm tắt bằng Hub AI từ transcript đã lưu, không xử lý lại toàn bộ.',
  inputSchema: {
    type: 'object',
    required: ['roomId', 'meetingId'],
    properties: { roomId: { type: 'string' }, meetingId: { type: 'string' } },
  },
  async execute(args, context) {
    const actor = requireVerifiedActor(context);
    const roomId = asString(args.roomId);
    const meetingId = asString(args.meetingId);
    if (!roomId || !meetingId) throw new AppError('roomId và meetingId là bắt buộc.');

    const db = new AppDbBotClient(roomId);
    const meeting = await requireMeetingOwner(db, actor, roomId, meetingId);
    if (!meeting.transcriptJsonFileId) {
      throw new AppError('Cuộc họp chưa có transcript để tóm tắt.');
    }

    // P6 fills in: download transcript.json, call Hub AI, write summary.md, update `meetings`.
    throw new AppError('Tóm tắt lại bằng Hub AI chưa được triển khai (Phase 6).');
  },
};
