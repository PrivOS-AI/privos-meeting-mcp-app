/**
 * Recording a Google Meet call on behalf of the Room's agent: three tools the
 * agent calls through the Hub (`mcp-apps.tool-call`, as the person who asked,
 * so the verified actor is that person) after it joined the call with the
 * Room's shared browser (PrivOS Remote Browser). The server does everything the
 * app tab would: the meeting row, its Files folder, listening to the browser
 * (`browser-audio/`), and processing at the end. No app tab needs to be open.
 *
 *  - `meeting_listen_start`: refuses until the caller confirms the participants
 *    were told the meeting is recorded (`participantsInformed`); a retry while
 *    that person's earlier start is still recording returns the same meeting.
 *  - `meeting_listen_status`: what it hears, or the result once processed.
 *  - `meeting_listen_stop`: saves the last part and starts processing.
 *
 * Owner-only like every recording tool; the meeting belongs to the caller.
 */
import { AppError } from '../../shared/app-error.js';
import { asLanguageCode, defaultTranslationTarget, SUPPORTED_LANGUAGES } from '../../shared/languages.js';
import { folderName, slugify } from '../../shared/meeting-slug.js';
import { browserAudioConfigured, browserAudioFor, startBrowserAudio, stopBrowserAudio } from '../browser-audio/browser-audio-listener.js';
import { ensureRoomFolderPath } from '../files/hub-folders.js';
import { AppDbBotClient, extractDbRecords } from '../hub/app-db-bot-client.js';
import { requireMeetingOwner, requireVerifiedActor } from './authz.js';
import { processTool } from './process-tool.js';
import { checkRateLimit } from './rate-limiter.js';
import type { AppTool } from './registry.js';
import { ROOM_AND_MEETING } from './schema-parts.js';

const STARTS_PER_USER = 5;
const START_WINDOW_MS = 60_000;
/** Captions the status returns: enough for the agent to say what is being said, not a transcript. */
const RECENT_CAPTIONS = 5;
const SUMMARY_CHARS = 3_000;

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function notConfigured(): AppError {
  return new AppError('Listening through the Room browser is not set up on this deployment.', 'PROVIDER_NOT_CONFIGURED');
}

export const listenStartTool: AppTool = {
  name: 'meeting_listen_start',
  title: 'Start recording the Room browser',
  description:
    "Start recording a meeting from the Room's shared browser (PrivOS Remote Browser) after it joined the call (e.g. Google Meet): live captions, then transcript and summary at the end. Only after the user confirmed the participants were told the meeting is recorded.",
  inputSchema: {
    type: 'object',
    required: ['roomId', 'participantsInformed'],
    properties: {
      roomId: ROOM_AND_MEETING.roomId,
      title: { type: 'string', maxLength: 200, description: 'Meeting title; defaults to "Google Meet <date>".' },
      language: { type: 'string', enum: [...SUPPORTED_LANGUAGES], description: 'Main spoken language (default vi).' },
      participantsInformed: { type: 'boolean', const: true, description: 'The user confirmed the participants were told the meeting is recorded and voices may be recognised.' },
    },
  },
  async execute(args, context, runtime) {
    const actor = requireVerifiedActor(context);
    const roomId = text(args.roomId, 128);
    if (!roomId) throw new AppError('Invalid meeting_listen_start parameters.', 'INVALID_INPUT');
    if (actor.roomId !== roomId) throw new AppError('Invalid request for this room.', 'ROOM_MISMATCH');
    if (args.participantsInformed !== true) {
      throw new AppError('Ask the user to confirm the participants were told the meeting is recorded, then call again with participantsInformed: true.', 'INVALID_INPUT');
    }
    if (!browserAudioConfigured()) throw notConfigured();
    if (!checkRateLimit('meeting_listen_start', actor.userId, STARTS_PER_USER, START_WINDOW_MS)) {
      throw new AppError('Too many recording starts — wait a minute.', 'RATE_LIMITED');
    }
    const db = new AppDbBotClient(roomId);
    const hub = runtime.agentBotHub;

    // A retry (the agent ran the step twice, or the app restarted) continues this person's running recording.
    const running = extractDbRecords(
      await db.query('meetings', 'room', {
        where: [
          { field: 'ownerUserId', op: '==', value: actor.userId },
          { field: 'status', op: '==', value: 'recording' },
          { field: 'captureSource', op: '==', value: 'browser' },
        ],
        limit: 5,
      }),
    ).find((row) => row.roomId === roomId && typeof row.folderId === 'string' && row.folderId);
    if (running) {
      const listener = startBrowserAudio({ db, hub, roomId, folderId: running.folderId as string, meetingId: running._id });
      return { meetingId: running._id, title: running.title ?? '', continued: true, ...listener.status() };
    }

    const language = asLanguageCode(args.language);
    const startedAt = new Date();
    const title = text(args.title, 200) || `Google Meet ${startedAt.toISOString().slice(0, 16).replace('T', ' ')}`;
    const created = (await db.create('meetings', 'room', {
      roomId,
      title,
      slug: slugify(title),
      language,
      translationEnabled: false,
      translationLang: defaultTranslationTarget(language),
      voiceprintNoticeAt: startedAt.toISOString(),
      ownerUserId: actor.userId,
      startedAt: startedAt.toISOString(),
      status: 'recording',
      partCount: 0,
      lastPartAt: startedAt.toISOString(),
      captureSource: 'browser',
    })) as { _id?: unknown } | null;
    const meetingId = typeof created?._id === 'string' ? created._id : '';
    if (!meetingId) throw new AppError('App DB did not return the new meeting.', 'HUB_ERROR');
    try {
      const folderId = await ensureRoomFolderPath(hub, roomId, folderName(title, meetingId, startedAt));
      await db.update('meetings', 'room', meetingId, { folderId });
      const listener = startBrowserAudio({ db, hub, roomId, folderId, meetingId });
      return { meetingId, title, continued: false, ...listener.status() };
    } catch (error) {
      // Nothing was recorded: do not leave a half-made meeting in the history.
      await db.delete('meetings', 'room', meetingId).catch(() => undefined);
      throw error;
    }
  },
};

export const listenStatusTool: AppTool = {
  name: 'meeting_listen_status',
  title: 'Room browser recording status',
  description: 'Whether a meeting recorded from the Room browser hears the call (and the latest captions), or its summary once processed — only the meeting owner.',
  inputSchema: { type: 'object', required: ['roomId', 'meetingId'], properties: { ...ROOM_AND_MEETING } },
  async execute(args, context) {
    const actor = requireVerifiedActor(context);
    const roomId = text(args.roomId, 128);
    const meetingId = text(args.meetingId, 128);
    if (!roomId || !meetingId) throw new AppError('Invalid meeting_listen_status parameters.', 'INVALID_INPUT');
    const meeting = await requireMeetingOwner(new AppDbBotClient(roomId), actor, roomId, meetingId);
    const listener = browserAudioFor(meetingId);
    if (listener) {
      const { captions } = listener.captionsSince(0);
      return {
        meetingId,
        status: 'recording',
        ...listener.status(),
        recentCaptions: captions.slice(-RECENT_CAPTIONS).map((c) => ({ atSec: Math.round(c.atSec), text: c.text })),
      };
    }
    return {
      meetingId,
      status: typeof meeting.status === 'string' ? meeting.status : 'unknown',
      ...(typeof meeting.summaryText === 'string' && meeting.summaryText ? { summary: meeting.summaryText.slice(0, SUMMARY_CHARS) } : {}),
      ...(Array.isArray(meeting.keyTopics) ? { keyTopics: meeting.keyTopics.slice(0, 10) } : {}),
      ...(typeof meeting.summaryError === 'string' && meeting.summaryError ? { summaryError: meeting.summaryError.slice(0, 500) } : {}),
    };
  },
};

export const listenStopTool: AppTool = {
  name: 'meeting_listen_stop',
  title: 'Stop recording the Room browser',
  description: 'Stop recording a meeting from the Room browser, save the last audio and start the transcript and summary — only the meeting owner. Poll meeting_listen_status for the summary.',
  inputSchema: { type: 'object', required: ['roomId', 'meetingId'], properties: { ...ROOM_AND_MEETING } },
  async execute(args, context, runtime) {
    const actor = requireVerifiedActor(context);
    const roomId = text(args.roomId, 128);
    const meetingId = text(args.meetingId, 128);
    if (!roomId || !meetingId) throw new AppError('Invalid meeting_listen_stop parameters.', 'INVALID_INPUT');
    const db = new AppDbBotClient(roomId);
    const meeting = await requireMeetingOwner(db, actor, roomId, meetingId);
    // Stopped already (a retry): processing is idempotent, so just report it again.
    const heard = await stopBrowserAudio(meetingId);
    if (meeting.status === 'recording') {
      const durationSec = heard ? Math.round(heard.heardSec) : Math.round((Date.now() - Date.parse(String(meeting.startedAt))) / 1000);
      await db.update('meetings', 'room', meetingId, { endedAt: new Date().toISOString(), durationSec, status: 'uploading' });
    }
    const processing = (await processTool.execute({ roomId, meetingId }, context, runtime)) as { jobId?: string; status?: string };
    return { meetingId, heardSec: heard?.heardSec ?? null, jobId: processing.jobId, processing: processing.status };
  },
};
