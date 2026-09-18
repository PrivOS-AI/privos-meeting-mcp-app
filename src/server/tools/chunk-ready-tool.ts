/**
 * `meeting_chunk_ready {roomId, meetingId, seq, durationMs, segments[]}` —
 * P5: authorizes the caller, validates the shape/bounds of the turns
 * uploaded for one part (structural checks only — the audio-aware span
 * window + RMS silence checks run inside `live-speakers/chunk-worker.ts`,
 * once it actually has the decoded PCM to check against), then enqueues the
 * chunk worker and returns `{accepted:true}` immediately. Processing itself
 * (embedding, matching, `meeting_speakers`/`live-turns.json` writes) happens
 * asynchronously behind `keyed-serial-queue.ts` — losing that work only
 * delays live labels, never blocks/corrupts the recording itself.
 *
 * Degraded mode (QĐ-18): a meeting whose realtime provider does not support
 * speaker labels (currently: `elevenlabs-realtime`) never gets a real chunk
 * enqueued — the iframe should not even be calling this for such a meeting,
 * but a stray/forced call is answered with `{accepted:false,
 * reason:'labels_not_supported'}` rather than an error.
 */
import { AppError } from '../../shared/app-error.js';
import { AppDbBotClient } from '../hub/app-db-bot-client.js';
import { enqueueChunk } from '../live-speakers/chunk-worker.js';
import { resolveRealtimeVendor, realtimeProviderFor } from '../stt/stt-provider-registry.js';
import { asChunkSegment, assertStructuralSpans, type ChunkSegment } from './span-validation.js';
import type { AppTool } from './registry.js';

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export const chunkReadyTool: AppTool = {
  name: 'meeting_chunk_ready',
  title: 'Báo phần ghi âm sẵn sàng',
  description: 'Nhận và kiểm tra các turn của một phần ghi âm vừa upload xong (hàng đợi xử lý ở Phase 5).',
  inputSchema: {
    type: 'object',
    required: ['roomId', 'meetingId', 'seq', 'durationMs', 'segments'],
    properties: {
      roomId: { type: 'string' },
      meetingId: { type: 'string' },
      seq: { type: 'number' },
      durationMs: { type: 'number' },
      segments: { type: 'array', items: { type: 'object' } },
    },
  },
  async execute(args, context, runtime) {
    const roomId = asString(args.roomId);
    const meetingId = asString(args.meetingId);
    const seq = Number(args.seq);
    const durationMs = Number(args.durationMs);
    if (!roomId || !meetingId || !Number.isInteger(seq) || seq < 0 || !Number.isFinite(durationMs) || durationMs <= 0) {
      throw new AppError('Tham số meeting_chunk_ready không hợp lệ.');
    }

    const actor = context.actor;
    if (!actor || actor.roomId !== roomId) {
      throw new AppError('Yêu cầu không hợp lệ cho phòng này.');
    }

    const db = new AppDbBotClient(roomId);
    const meeting = await db.getById('meetings', 'room', meetingId);
    if (!meeting || meeting.roomId !== roomId) {
      throw new AppError('Không tìm thấy cuộc họp trong phòng này.');
    }
    if (meeting.ownerUserId !== actor.userId) {
      throw new AppError('Chỉ chủ cuộc họp mới gửi được meeting_chunk_ready.');
    }
    if (meeting.status !== 'recording' && meeting.status !== 'uploading') {
      throw new AppError('Cuộc họp không ở trạng thái nhận phần ghi âm.');
    }

    const vendor = await resolveRealtimeVendor(db);
    if (!realtimeProviderFor(vendor).capabilities.speakerLabels) {
      // QĐ-18 degraded mode — not an error, just nothing to do.
      return { accepted: false, reason: 'labels_not_supported' };
    }

    const segmentsRaw = Array.isArray(args.segments) ? args.segments : [];
    const segments = segmentsRaw.map(asChunkSegment).filter((s): s is ChunkSegment => s !== null);
    if (segments.length !== segmentsRaw.length) {
      throw new AppError('Một số turn có dữ liệu không hợp lệ.');
    }
    const structuralError = assertStructuralSpans(segments, durationMs);
    if (structuralError) throw new AppError(structuralError);

    const folderId = typeof meeting.folderId === 'string' && meeting.folderId ? meeting.folderId : '';
    if (!folderId) throw new AppError('Cuộc họp chưa có thư mục lưu trữ.');

    enqueueChunk({ db, hub: runtime.agentBotHub, folderId }, { roomId, meetingId, seq, durationMs, segments });

    return { accepted: true };
  },
};
