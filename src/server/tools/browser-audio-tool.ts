/**
 * `meeting_browser_audio` — record a meeting from the Room's shared browser
 * (PrivOS Remote Browser, e.g. sitting in a Google Meet call) instead of the
 * microphone. `start` opens the server-side listener
 * (`browser-audio/browser-audio-listener.ts`), `poll` returns its state and the
 * captions since `cursor` (the iframe has no audio to push, so it asks), `stop`
 * ends it once the last part is saved. Only the meeting owner, only while the
 * meeting records (except `stop`, which also runs from `meeting_process`).
 */
import { AppError } from '../../shared/app-error.js';
import { browserAudioConfigured, browserAudioFor, startBrowserAudio, stopBrowserAudio } from '../browser-audio/browser-audio-listener.js';
import { AppDbBotClient } from '../hub/app-db-bot-client.js';
import { requireMeetingOwner, requireVerifiedActor } from './authz.js';
import { checkRateLimit } from './rate-limiter.js';
import type { AppTool } from './registry.js';
import { ROOM_AND_MEETING } from './schema-parts.js';

const ACTIONS = ['start', 'poll', 'stop'] as const;
type Action = (typeof ACTIONS)[number];

/** Polls per meeting per window: ~1/s expected. */
const POLL_LIMIT = 8;
const POLL_WINDOW_MS = 4_000;
/** A verified owner is not re-checked on every poll. */
const OWNER_CHECK_TTL_MS = 30_000;
const ownerChecks = new Map<string, number>();

export function resetBrowserAudioOwnerChecksForTests(): void {
  ownerChecks.clear();
}

export const browserAudioTool: AppTool = {
  name: 'meeting_browser_audio',
  title: 'Record from the Room browser',
  description: "Record a meeting from the Room's shared browser (for example a Google Meet call it joined) instead of the microphone: start, poll for live captions, stop — only the meeting owner.",
  inputSchema: {
    type: 'object',
    required: ['roomId', 'meetingId', 'action'],
    properties: {
      ...ROOM_AND_MEETING,
      action: { type: 'string', enum: [...ACTIONS] },
      cursor: { type: 'integer', minimum: 0, maximum: 10_000_000 },
    },
  },
  async execute(args, context, runtime) {
    const actor = requireVerifiedActor(context);
    const roomId = typeof args.roomId === 'string' ? args.roomId.trim() : '';
    const meetingId = typeof args.meetingId === 'string' ? args.meetingId.trim() : '';
    const action = args.action as Action;
    const cursor = args.cursor === undefined ? 0 : Number(args.cursor);
    if (!roomId || !meetingId || !ACTIONS.includes(action) || !Number.isInteger(cursor) || cursor < 0) {
      throw new AppError('Invalid meeting_browser_audio parameters.', 'INVALID_INPUT');
    }
    if (!browserAudioConfigured()) throw new AppError('Listening through the Room browser is not set up on this deployment.', 'PROVIDER_NOT_CONFIGURED');

    const db = new AppDbBotClient(roomId);
    const checkKey = `${meetingId}:${actor.userId}`;
    const checkOwner = async (requireRecording: boolean) => {
      const meeting = await requireMeetingOwner(db, actor, roomId, meetingId);
      if (requireRecording && meeting.status !== 'recording') throw new AppError('Meeting is not currently recording.', 'INVALID_STATE');
      ownerChecks.set(checkKey, Date.now() + OWNER_CHECK_TTL_MS);
      return meeting;
    };

    if (action === 'start') {
      const meeting = await checkOwner(true);
      const folderId = typeof meeting.folderId === 'string' ? meeting.folderId : '';
      if (!folderId) throw new AppError('The meeting has no Files folder yet.', 'INVALID_STATE');
      const listener = startBrowserAudio({ db, hub: runtime.agentBotHub, roomId, folderId, meetingId });
      return { ...listener.status(), ...listener.captionsSince(cursor) };
    }

    if (action === 'stop') {
      await checkOwner(false);
      const status = await stopBrowserAudio(meetingId);
      return status ?? { state: 'stopped', heardSec: 0, partsUploaded: 0 };
    }

    if ((ownerChecks.get(checkKey) ?? 0) < Date.now()) await checkOwner(true);
    if (!checkRateLimit('meeting_browser_audio', meetingId, POLL_LIMIT, POLL_WINDOW_MS)) {
      throw new AppError('Too many polls for this meeting — slow down.', 'RATE_LIMITED');
    }
    const listener = browserAudioFor(meetingId);
    if (!listener) throw new AppError('This meeting is not listening to the Room browser.', 'INVALID_STATE');
    return { ...listener.status(), ...listener.captionsSince(cursor) };
  },
};
