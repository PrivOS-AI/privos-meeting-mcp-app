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
import type { AppTool } from './registry.js';

export const bootstrapTool: AppTool = {
  name: 'meeting_bootstrap',
  title: 'Khởi tạo dữ liệu phòng',
  description: 'Đăng ký schema App DB, ghi nhận phòng và đảm bảo bot là thành viên phòng.',
  inputSchema: { type: 'object', required: ['roomId'], properties: { roomId: { type: 'string' } } },
  async execute(args) {
    const roomId = typeof args.roomId === 'string' ? args.roomId.trim() : '';
    if (!roomId) throw new AppError('roomId là bắt buộc.');

    const db = new AppDbBotClient(roomId);
    await ensureAppDbSchema(db);
    const knownRooms = await appendKnownRoom(db, roomId);
    const botJoined = await ensureBotInRoom(roomId);

    return { ok: true, roomId, knownRoomCount: knownRooms.length, botJoined };
  },
};
