/**
 * `meeting_audio_push` — live audio for the `local` speech-to-text provider.
 * The iframe sends ~500 ms of 16 kHz mono PCM16 per call (it has no direct
 * route to the container: everything goes through the host bridge) and gets
 * back the captions recognised since its cursor. Only the meeting owner, only
 * while recording; idempotent per `seq` (a retried push is not fed twice).
 */
import { AppError } from '../../shared/app-error.js';
import { existingLiveSession, liveSessionFor, pcm16ToFloat32 } from '../asr/live-asr-session.js';
import { createLocalSpeakerAttributor } from '../live-speakers/local-attribution.js';
import { SAMPLE_RATE } from '../asr/asr-engine.js';
import { env } from '../env.js';
import { AppDbBotClient } from '../hub/app-db-bot-client.js';
import { requireMeetingOwner, requireVerifiedActor } from './authz.js';
import { checkRateLimit } from './rate-limiter.js';
import type { AppTool } from './registry.js';
import { MS, ROOM_AND_MEETING } from './schema-parts.js';

/**
 * One push carries at most ~4 s of 16 kHz PCM16 (128 KB), base64-encoded. A relay round trip takes
 * ~1.5 s, so the client sends whatever piled up meanwhile; at 1 s per push it fell further behind each time.
 */
const MAX_PCM_BYTES = 131_072;
const MAX_PCM_BASE64 = Math.ceil(MAX_PCM_BYTES / 3) * 4;
/** Pushes per meeting per window: ~2/s expected, room for a burst of retries. */
const PUSH_LIMIT = 12;
/** How long a push waits for the decodes it started. */
const SETTLE_MS = 700;
/** A verified owner of a recording meeting is not re-checked for this long. */
const OWNER_CHECK_TTL_MS = 30_000;
const ownerChecks = new Map<string, { until: number; folderId: string }>();

export function resetAudioPushOwnerChecksForTests(): void {
  ownerChecks.clear();
}
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
      captions: { type: 'boolean', description: 'false: just feed the audio and answer at once (the client reads captions with meeting_captions_wait).' },
    },
  },
  async execute(args, context, runtime) {
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
    if (pcm.length > MAX_PCM_BASE64) throw new AppError('Audio chunk is too large (at most about 4 seconds per push).', 'INVALID_INPUT');

    // Pushes arrive every ~1.5 s: the owner/recording check goes to App DB (a Hub round trip)
    // once per OWNER_CHECK_TTL_MS, not on every push, so it stays off the caption path.
    const checkKey = `${meetingId}:${actor.userId}`;
    const db = new AppDbBotClient(roomId);
    let check = ownerChecks.get(checkKey);
    if (!check || check.until < Date.now()) {
      const meeting = await requireMeetingOwner(db, actor, roomId, meetingId);
      if (meeting.status !== 'recording') throw new AppError('Meeting is not currently recording.', 'INVALID_STATE');
      check = { until: Date.now() + OWNER_CHECK_TTL_MS, folderId: typeof meeting.folderId === 'string' ? meeting.folderId : '' };
      ownerChecks.set(checkKey, check);
    }
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

    // Live speakers: each finished utterance is attributed to a session speaker by voice.
    if (!session.attributeSpeaker && check.folderId) {
      session.attributeSpeaker = createLocalSpeakerAttributor({ db, hub: runtime.agentBotHub, roomId, folderId: check.folderId, meetingId });
    }

    const bytes = Buffer.from(pcm, 'base64');
    if (bytes.length > MAX_PCM_BYTES || bytes.length % 2 !== 0) throw new AppError('Audio chunk must be whole PCM16 samples, at most 128 KB.', 'INVALID_INPUT');
    await session.push(seq, chunkStartSec, pcm16ToFloat32(bytes));
    if (args.captions === false) return { cursor: session.captionsSince(cursor).cursor, degraded: session.degraded };
    // An utterance that just ended is usually decoded within this wait, so its caption
    // rides this answer instead of the next push ~1.5 s later.
    await session.settle(SETTLE_MS);
    return { ...session.captionsSince(cursor), degraded: session.degraded };
  },
};

/** Caption waits per meeting per window: the client keeps two open, each re-asked as it answers (about every draft). */
const WAIT_LIMIT = 80;
const WAIT_WINDOW_MS = 10_000;
/** Longest a wait is held open; well under any relay timeout. */
const MAX_WAIT_MS = 6_000;

/**
 * `meeting_captions_wait` — live captions as soon as they are decoded: answers at
 * once when there is a caption at or after `cursor` or the draft moved past
 * `draftRev`, otherwise holds the request open (at most `waitMs`) until there is.
 * The client keeps one wait open while it pushes audio, so a caption no longer
 * waits for the next push to ride back on. Meeting owner only, while recording;
 * it never starts a session (audio pushes and the Room-browser listener do).
 */
export const captionsWaitTool: AppTool = {
  name: 'meeting_captions_wait',
  title: 'Wait for live captions',
  description: "Get the meeting's new live captions as soon as they are recognised (held open briefly until there are some) — only the meeting owner, while recording.",
  inputSchema: {
    type: 'object',
    required: ['roomId', 'meetingId', 'cursor'],
    properties: {
      ...ROOM_AND_MEETING,
      cursor: { type: 'integer', minimum: 0, maximum: 10_000_000 },
      draftRev: { type: 'integer', minimum: 0, maximum: 1_000_000_000, description: 'The draft revision the client shows; a newer draft answers at once.' },
      waitMs: { type: 'integer', minimum: 0, maximum: MAX_WAIT_MS },
    },
  },
  async execute(args, context) {
    const actor = requireVerifiedActor(context);
    const roomId = typeof args.roomId === 'string' ? args.roomId.trim() : '';
    const meetingId = typeof args.meetingId === 'string' ? args.meetingId.trim() : '';
    const cursor = Number(args.cursor);
    const draftRev = args.draftRev === undefined ? -1 : Number(args.draftRev);
    const waitMs = args.waitMs === undefined ? MAX_WAIT_MS : Number(args.waitMs);
    if (!roomId || !meetingId || !Number.isInteger(cursor) || cursor < 0 || !Number.isInteger(draftRev) || !Number.isInteger(waitMs) || waitMs < 0 || waitMs > MAX_WAIT_MS) {
      throw new AppError('Invalid meeting_captions_wait parameters.', 'INVALID_INPUT');
    }
    const checkKey = `${meetingId}:${actor.userId}`;
    const check = ownerChecks.get(checkKey);
    if (!check || check.until < Date.now()) {
      const meeting = await requireMeetingOwner(new AppDbBotClient(roomId), actor, roomId, meetingId);
      if (meeting.status !== 'recording') throw new AppError('Meeting is not currently recording.', 'INVALID_STATE');
      ownerChecks.set(checkKey, { until: Date.now() + OWNER_CHECK_TTL_MS, folderId: typeof meeting.folderId === 'string' ? meeting.folderId : '' });
    }
    if (!checkRateLimit('meeting_captions_wait', meetingId, WAIT_LIMIT, WAIT_WINDOW_MS)) {
      throw new AppError('Too many caption requests for this meeting — slow down.', 'RATE_LIMITED');
    }
    const session = existingLiveSession(meetingId);
    if (!session) {
      // No audio has arrived yet: come back shortly instead of holding a request for nothing.
      await new Promise((resolve) => setTimeout(resolve, Math.min(waitMs, 1_000)));
      return { captions: [], cursor, draft: null, draftRev: 0, degraded: false };
    }
    await session.waitForUpdate(cursor, draftRev, waitMs);
    return { ...session.captionsSince(cursor), degraded: session.degraded };
  },
};
