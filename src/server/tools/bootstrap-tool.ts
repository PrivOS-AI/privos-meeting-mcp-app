/**
 * `meeting_bootstrap {roomId}` — one-time-per-room setup, idempotent. Registers
 * every App DB collection room-lessly for globals and room-scoped for the rest,
 * records the room in `knownRooms`, and ensures the installation bot is a member
 * of the room so it can write Files.
 *
 * Reserved seams (filled in later phases): sweep interrupted jobs (P3), sweep
 * abandoned recording meetings (P3), delete expired audio (P8).
 */
import { AppError } from '../../shared/app-error.js';
import { AppDbBotClient, ensureAppDbSchema } from '../hub/app-db-bot-client.js';
import { appendKnownRoom } from '../hub/app-settings.js';
import { ensureBotInRoom } from '../hub/ensure-bot-in-room.js';
import { purgeExpiredAudio } from '../jobs/audio-retention-job.js';
import { sweepRoom } from '../jobs/startup-sweep.js';
import type { AppTool } from './registry.js';

export const bootstrapTool: AppTool = {
  name: 'meeting_bootstrap',
  title: 'Khởi tạo dữ liệu phòng',
  description: 'Đăng ký schema App DB, ghi nhận phòng và đảm bảo bot là thành viên phòng.',
  inputSchema: { type: 'object', required: ['roomId'], properties: { roomId: { type: 'string' } } },
  async execute(args, _context, runtime) {
    const roomId = typeof args.roomId === 'string' ? args.roomId.trim() : '';
    if (!roomId) throw new AppError('roomId là bắt buộc.');

    const db = new AppDbBotClient(roomId);
    await ensureAppDbSchema(db);
    const knownRooms = await appendKnownRoom(db, roomId);
    const botJoined = await ensureBotInRoom(roomId);

    // Best-effort: requeue this room's stuck jobs / abandoned recordings /
    // dead vendor garbage every time the room opens, not just at process boot.
    await sweepRoom(runtime.agentBotHub, roomId).catch((error) => {
      console.warn('[meeting_bootstrap] sweep thất bại (không chặn bootstrap):', error instanceof Error ? error.message : error);
    });

    // Best-effort: retention (kept audio past autoDeleteAudioDays, orphaned
    // interrupted parts, stale pendingEmbedding) — same "every time the room
    // opens" cadence as the sweep above, on top of the 6h interval.
    await purgeExpiredAudio(runtime.agentBotHub, roomId).catch((error) => {
      console.warn('[meeting_bootstrap] retention thất bại (không chặn bootstrap):', error instanceof Error ? error.message : error);
    });

    return { ok: true, roomId, knownRoomCount: knownRooms.length, botJoined };
  },
};
