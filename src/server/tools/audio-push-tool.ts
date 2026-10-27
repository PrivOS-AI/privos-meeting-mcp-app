/**
 * `meeting_audio_push` — live audio for the `local` speech-to-text provider.
 * The iframe sends ~500 ms of 16 kHz mono PCM16 per call (it has no direct
 * route to the container: everything goes through the host bridge) and gets
 * back the captions recognised since its cursor. Only the meeting owner, only
 * while recording; idempotent per `seq` (a retried push is not fed twice).
 */
import { AppError } from '../../shared/app-error.js';
import { liveSessionFor, pcm16ToFloat32 } from '../asr/live-asr-session.js';
import { SAMPLE_RATE } from '../asr/asr-engine.js';
import { env } from '../env.js';
import { AppDbBotClient } from '../hub/app-db-bot-client.js';
import { requireMeetingOwner, requireVerifiedActor } from './authz.js';
import { checkRateLimit } from './rate-limiter.js';
import type { AppTool } from './registry.js';
import { MS, ROOM_AND_MEETING } from './schema-parts.js';

/** One push carries at most ~1 s of 16 kHz PCM16 (32 KB), base64-encoded. */
const MAX_PCM_BYTES = 32_768;
const MAX_PCM_BASE64 = Math.ceil(MAX_PCM_BYTES / 3) * 4;
/** Pushes per meeting per window: ~2/s expected, room for a burst of retries. */
const PUSH_LIMIT = 12;
const PUSH_WINDOW_MS = 2_000;

export const audioPushTool: AppTool = {
  name: 'meeting_audio_push',
  title: 'Push live audio',
  description: "Send a short chunk of the meeting's live audio to the app's own speech recognizer and receive the new captions — only the meeting owner, while recording.",
  inputSchema: {
    type: 'object',
    required: ['roomId', 'meetingId', 'seq', 'chunkStartSec', 'sampleRate', 'pcm'],
    properties: {
      ...ROOM_AND_MEETING,
      seq: { type: 'integer', minimum: 0, maximum: 10_000_000 },
      chunkStartSec: { ...MS, description: 'Meeting-clock seconds of the first sample in this chunk.' },
      sampleRate: { type: 'integer', enum: [SAMPLE_RATE] },
      pcm: { type: 'string', maxLength: MAX_PCM_BASE64, description: 'Base64 little-endian PCM16 mono.' },
      cursor: { type: 'integer', minimum: 0, maximum: 10_000_000 },
    },
  },
  async execute(args, context) {
    const actor = requireVerifiedActor(context);
    const roomId = typeof args.roomId === 'string' ? args.roomId.trim() : '';
    const meetingId = typeof args.meetingId === 'string' ? args.meetingId.trim() : '';
    const seq = Number(args.seq);
    const chunkStartSec = Number(args.chunkStartSec);
    const cursor = args.cursor === undefined ? 0 : Number(args.cursor);
    const pcm = typeof args.pcm === 'string' ? args.pcm : '';
    if (!roomId || !meetingId || !Number.isInteger(seq) || seq < 0 || !Number.isFinite(chunkStartSec) || chunkStartSec < 0 || !Number.isInteger(cursor) || cursor < 0) {
      throw new AppError('Invalid meeting_audio_push parameters.', 'INVALID_INPUT');
    }
    if (Number(args.sampleRate) !== SAMPLE_RATE) throw new AppError(`Audio must be ${SAMPLE_RATE} Hz mono PCM16.`, 'INVALID_INPUT');
    if (pcm.length > MAX_PCM_BASE64) throw new AppError('Audio chunk is too large (at most about 1 second per push).', 'INVALID_INPUT');

    const db = new AppDbBotClient(roomId);
    const meeting = await requireMeetingOwner(db, actor, roomId, meetingId);
    if (meeting.status !== 'recording') throw new AppError('Meeting is not currently recording.', 'INVALID_STATE');
    if (!checkRateLimit('meeting_audio_push', meetingId, PUSH_LIMIT, PUSH_WINDOW_MS)) {
      throw new AppError('Too many audio pushes for this meeting — slow down.', 'RATE_LIMITED');
    }

    const session = liveSessionFor(meetingId, env.liveMaxConcurrentRecordings);
    if (!session) {
      throw new AppError(
        `The app is already captioning the maximum of ${env.liveMaxConcurrentRecordings} meetings, so live captions are temporarily unavailable — the recording keeps running.`,
        'CAPACITY_REACHED',
      );
    }

    const bytes = Buffer.from(pcm, 'base64');
    if (bytes.length > MAX_PCM_BYTES || bytes.length % 2 !== 0) throw new AppError('Audio chunk must be whole PCM16 samples, at most 32 KB.', 'INVALID_INPUT');
    await session.push(seq, chunkStartSec, pcm16ToFloat32(bytes));
    return { ...session.captionsSince(cursor), degraded: session.degraded };
  },
};
