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
 * The bot acts on whatever room it is given, so the room must be the caller's
 * own verified room — never a `roomId` from the arguments alone. Each run also
 * sweeps stuck jobs and abandoned recordings and applies retention for the room.
 */
import { AppError } from '../../shared/app-error.js';
import { AppDbBotClient, ensureAppDbSchema } from '../hub/app-db-bot-client.js';
import { resolveHubOrigin } from '../hub/resolve-hub-origin.js';
import { purgeExpiredAudio } from '../jobs/audio-retention-job.js';
import { addKnownRoom } from '../jobs/known-rooms-store.js';
import { sweepRoom } from '../jobs/startup-sweep.js';
import { requireVerifiedActor } from './authz.js';
import type { AppTool } from './registry.js';
import { ID } from './schema-parts.js';

export const bootstrapTool: AppTool = {
  name: 'meeting_bootstrap',
  title: 'Bootstrap room data',
  description: 'Register the App DB schema, record the room, and ensure the bot is a room member.',
  inputSchema: { type: 'object', required: ['roomId'], properties: { roomId: ID } },
  async execute(args, context, runtime) {
    const actor = requireVerifiedActor(context);
    const roomId = typeof args.roomId === 'string' ? args.roomId.trim() : '';
    if (!roomId) throw new AppError('roomId is required.', 'INVALID_INPUT');
    if (actor.roomId !== roomId) throw new AppError('Invalid request for this room.', 'ROOM_MISMATCH');

    const db = new AppDbBotClient(roomId);
    await ensureAppDbSchema(db);
    const knownRooms = await addKnownRoom(roomId);

    // Best-effort: requeue this room's stuck jobs / abandoned recordings /
    // dead vendor garbage every time the room opens, not just at process boot.
    await sweepRoom(runtime.agentBotHub, roomId).catch((error) => {
      console.warn('[meeting_bootstrap] sweep failed (not blocking bootstrap):', error instanceof Error ? error.message : error);
    });

    // Best-effort: retention (kept audio past autoDeleteAudioDays, orphaned
    // interrupted parts, stale pendingEmbedding) — same "every time the room
    // opens" cadence as the sweep above, on top of the 6h interval.
    await purgeExpiredAudio(runtime.agentBotHub, roomId).catch((error) => {
      console.warn('[meeting_bootstrap] retention failed (not blocking bootstrap):', error instanceof Error ? error.message : error);
    });

    // The Hub's own address, for loading people's avatars (`<hub>/avatar/<username>`, public): the iframe
    // runs in an opaque origin and the host context does not carry it.
    const hubOrigin = await resolveHubOrigin().catch(() => undefined);
    return { ok: true, roomId, knownRoomCount: knownRooms.length, ...(hubOrigin ? { hubOrigin } : {}) };
  },
};
