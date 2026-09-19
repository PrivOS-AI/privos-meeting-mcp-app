/**
 * `meeting_realtime_token {roomId, meetingId}` — mints a short-lived realtime
 * STT credential for the iframe SDK of whichever provider the workspace has
 * active (QĐ-15). Enforces, in order: caller is the meeting owner and it is
 * still `recording`; a per-(user,meeting) mint budget; and a workspace-wide
 * concurrent-recording cap applied to BOTH providers (QĐ-19 — ElevenLabs
 * realtime's true concurrency limit is unverified, open question #8).
 */
import { AppError } from '../../shared/app-error.js';
import { AppDbBotClient, extractDbRecords } from '../hub/app-db-bot-client.js';
import { readKnownRooms } from '../jobs/known-rooms-store.js';
import { env } from '../env.js';
import { realtimeProviderFor, resolveRealtimeVendor } from '../stt/stt-provider-registry.js';
import type { AppTool } from './registry.js';
import { checkRateLimit } from './rate-limiter.js';

const BUDGET_PER_HOUR = 30;
const BUDGET_WINDOW_MS = 60 * 60 * 1000;
/**
 * A `recording` meeting only counts toward the concurrency cap while its
 * `lastPartAt` heartbeat is this fresh — mirrors the "still alive" signal the
 * abandoned-meeting sweep (P3) uses. A brand-new meeting with no part uploaded
 * yet does not count itself (documented trade-off: undercounts the first ~60s
 * of a burst of simultaneous new recordings).
 */
const CONCURRENCY_FRESHNESS_MS = 5 * 60 * 1000;

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

async function countFreshRecordings(freshSinceIso: string): Promise<number> {
  const knownRooms = await readKnownRooms();
  let total = 0;
  for (const roomId of knownRooms) {
    const roomDb = new AppDbBotClient(roomId);
    try {
      const result = await roomDb.query('meetings', 'room', {
        where: [
          { field: 'status', op: '==', value: 'recording' },
          { field: 'lastPartAt', op: '>=', value: freshSinceIso },
        ],
        limit: 1000,
      });
      total += extractDbRecords(result).length;
    } catch (error) {
      // A known room the bot can no longer read (removed from the room, room
      // deleted) must not block captions everywhere else — it simply has no
      // countable recordings.
      console.warn('[meeting_realtime_token] bỏ qua phòng không đọc được khi đếm phiên:', { roomId, error: error instanceof Error ? error.message : error });
    }
  }
  return total;
}

/**
 * Exported for `stt-status-tool.ts`'s admin view ("số phiên realtime đang
 * chạy / LIVE_MAX_CONCURRENT_RECORDINGS") — same freshness window and query
 * this tool's own concurrency gate uses, so the two numbers a caller sees
 * (the cap that blocked them here, the count shown in Settings) never drift.
 */
export async function countActiveRealtimeRecordings(): Promise<number> {
  const freshSince = new Date(Date.now() - CONCURRENCY_FRESHNESS_MS).toISOString();
  return countFreshRecordings(freshSince);
}

export const realtimeTokenTool: AppTool = {
  name: 'meeting_realtime_token',
  title: 'Get live caption token',
  description: "Mint a short-lived realtime token for the selected STT provider's live caption SDK.",
  inputSchema: {
    type: 'object',
    required: ['roomId', 'meetingId'],
    properties: { roomId: { type: 'string' }, meetingId: { type: 'string' } },
  },
  async execute(args, context) {
    const roomId = asString(args.roomId);
    const meetingId = asString(args.meetingId);
    if (!roomId || !meetingId) throw new AppError('roomId và meetingId là bắt buộc.');

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
      throw new AppError('Chỉ chủ cuộc họp mới lấy được token phụ đề trực tiếp.');
    }
    if (meeting.status !== 'recording') {
      throw new AppError('Cuộc họp không ở trạng thái đang ghi.');
    }

    if (!checkRateLimit('meeting_realtime_token', `${actor.userId}:${meetingId}`, BUDGET_PER_HOUR, BUDGET_WINDOW_MS)) {
      throw new AppError('Đã vượt quá số lần lấy token phụ đề trực tiếp cho phép trong 1 giờ. Vui lòng thử lại sau.');
    }

    const freshSince = new Date(Date.now() - CONCURRENCY_FRESHNESS_MS).toISOString();
    const activeCount = await countFreshRecordings(freshSince);
    if (activeCount >= env.liveMaxConcurrentRecordings) {
      throw new AppError(
        `Hệ thống đang ghi tối đa ${env.liveMaxConcurrentRecordings} cuộc họp, phụ đề trực tiếp tạm không khả dụng — ` +
          'bản ghi vẫn chạy và tên người nói sẽ có sau khi xử lý.',
      );
    }

    const vendor = await resolveRealtimeVendor(db);
    const provider = realtimeProviderFor(vendor);
    const status = await provider.status();
    if (!status.configured) {
      const keyName = vendor === 'soniox' ? 'SONIOX_API_KEY' : 'ELEVENLABS_API_KEY';
      throw new AppError(
        `Nhà cung cấp phụ đề trực tiếp đang chọn (sttRealtimeProvider=${vendor}) thiếu khoá API — kiểm tra biến môi trường ${keyName}.`,
      );
    }

    // Never log the minted token — only who requested one, for which meeting/provider.
    console.log('[meeting_realtime_token]', { userId: actor.userId, roomId, meetingId, provider: vendor });
    return provider.mint(meetingId);
  },
};
