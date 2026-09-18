/**
 * `meeting_chunk_ready {roomId, meetingId, seq, durationMs, segments[]}` — the
 * P2 shell: authorizes the caller and validates the shape/bounds of the turns
 * uploaded for one part, then accepts. The sequential per-meeting queue,
 * persistence and speaker-embedding work are P5. Losing an `accepted` only
 * delays live labels (the backend can re-derive missing work from
 * `meetings.partCount`), so nothing here can corrupt stored data.
 */
import { AppError } from '../../shared/app-error.js';
import { AppDbBotClient } from '../hub/app-db-bot-client.js';
import type { AppTool } from './registry.js';

/** Generous ceiling on turns per ~60s part — guards against a malformed/hostile payload. */
const MAX_SEGMENTS_PER_CHUNK = 200;

interface ChunkSegment {
  speaker: string;
  startMs: number;
  endMs: number;
  final: boolean;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asChunkSegment(value: unknown): ChunkSegment | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const speaker = asString(raw.speaker);
  const startMs = Number(raw.startMs);
  const endMs = Number(raw.endMs);
  if (!speaker || !Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  return { speaker, startMs, endMs, final: raw.final === true };
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
  async execute(args, context) {
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

    const segmentsRaw = Array.isArray(args.segments) ? args.segments : [];
    if (segmentsRaw.length > MAX_SEGMENTS_PER_CHUNK) {
      throw new AppError('Quá nhiều turn trong một phần ghi âm.');
    }

    const segments = segmentsRaw.map(asChunkSegment).filter((s): s is ChunkSegment => s !== null);
    if (segments.length !== segmentsRaw.length) {
      throw new AppError('Một số turn có dữ liệu không hợp lệ.');
    }

    // Bounds + same-speaker overlap check — everything RMS/audio-based (real
    // span validation against the decoded part) is P5, once the chunk worker
    // has the actual audio bytes to check against.
    const bySpeaker = new Map<string, ChunkSegment[]>();
    for (const seg of segments) {
      if (seg.startMs < 0 || seg.endMs > durationMs || seg.startMs >= seg.endMs) {
        throw new AppError(`Turn của "${seg.speaker}" nằm ngoài biên phần ghi âm.`);
      }
      const list = bySpeaker.get(seg.speaker) ?? [];
      list.push(seg);
      bySpeaker.set(seg.speaker, list);
    }
    for (const list of bySpeaker.values()) {
      const sorted = [...list].sort((a, b) => a.startMs - b.startMs);
      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i].startMs < sorted[i - 1].endMs) {
          throw new AppError('Hai turn của cùng một người nói chồng lấn thời gian.');
        }
      }
    }

    return { accepted: true };
  },
};
