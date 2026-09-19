/**
 * `meeting_bootstrap {roomId}` — one-time-per-room setup, idempotent. Registers
 * every App DB collection (globals and room-scoped alike, all under this room's
 * permission context) and records the room in the node-local known-rooms registry.
 *
 * The installation bot must ALREADY be a member of the room: the Hub resolves a
 * non-member bot to an empty ACL ("Insufficient scope" on every db:* call), and
 * only a user-execution call may add it (`bot:room:join` is user-only), so the
 * iframe calls `mcpapp.bot.joinCurrentRoom` before invoking this tool.
 *
 * Reserved seams (filled in later phases): sweep interrupted jobs (P3), sweep
 * abandoned recording meetings (P3), delete expired audio (P8).
 */
import { AppError } from '../../shared/app-error.js';
import { AppDbBotClient, ensureAppDbSchema } from '../hub/app-db-bot-client.js';
import { purgeExpiredAudio } from '../jobs/audio-retention-job.js';
import { addKnownRoom } from '../jobs/known-rooms-store.js';
import { sweepRoom } from '../jobs/startup-sweep.js';
import type { AppTool } from './registry.js';

export const bootstrapTool: AppTool = {
  name: 'meeting_bootstrap',
  title: 'Bootstrap room data',
  description: 'Register the App DB schema, record the room, and ensure the bot is a room member.',
  inputSchema: { type: 'object', required: ['roomId'], properties: { roomId: { type: 'string' } } },
  async execute(args, _context, runtime) {
    const roomId = typeof args.roomId === 'string' ? args.roomId.trim() : '';
    if (!roomId) throw new AppError('roomId là bắt buộc.');

    const db = new AppDbBotClient(roomId);
    await ensureAppDbSchema(db);
    const knownRooms = await addKnownRoom(roomId);

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

    return { ok: true, roomId, knownRoomCount: knownRooms.length };
  },
};
