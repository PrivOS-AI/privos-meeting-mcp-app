/**
 * `meeting_live_speakers {roomId, meetingId}` — polled by the iframe every
 * 3-5s while recording (`live-speaker-poll.ts`). Room-member authz only (any
 * participant may see who is currently talking, not just the owner). Reads
 * straight from `meeting_speakers` — the in-process registry is the chunk
 * worker's own concern, this tool never touches it directly, so a poll works
 * the same whether or not this pm2 process is the one running the worker.
 *
 * DTO allowlist ONLY: never `pendingEmbedding`, never a raw vector — a test
 * asserts the response has no such field. `degraded:true` once any chunk for
 * this meeting has been dropped/failed; `labelsSupported:false` short-circuits
 * to an empty list when the meeting's realtime provider never had labels to
 * begin with (D-18) so the iframe can stop polling.
 */
import { AppError } from '../../shared/app-error.js';
import { AppDbBotClient, extractDbRecords } from '../hub/app-db-bot-client.js';
import { resolveRealtimeVendor, realtimeProviderFor } from '../stt/stt-provider-registry.js';
import { sessionRegistries } from '../speaker/session-speaker-registry.js';
import { requireRoomMeeting, requireVerifiedActor } from './authz.js';
import type { AppTool } from './registry.js';

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

export interface LiveSpeakerDto {
  sessionSpeakerId: string;
  sonioxLabels: string[];
  displayName?: string;
  profileId?: string;
  liveConfidence?: number;
  liveSpeechSec: number;
  colorKey: string;
  resolved: boolean;
  mergedInto?: string;
}

export const liveSpeakersTool: AppTool = {
  name: 'meeting_live_speakers',
  title: 'Live speakers',
  description: 'List of speakers detected during the meeting, with names when matched to a voiceprint profile.',
  inputSchema: {
    type: 'object',
    required: ['roomId', 'meetingId'],
    properties: { roomId: { type: 'string' }, meetingId: { type: 'string' } },
  },
  async execute(args, context) {
    const actor = requireVerifiedActor(context);
    const roomId = asString(args.roomId);
    const meetingId = asString(args.meetingId);
    if (!roomId || !meetingId) throw new AppError('roomId and meetingId are required.');

    const db = new AppDbBotClient(roomId);
    await requireRoomMeeting(db, actor, roomId, meetingId);

    const vendor = await resolveRealtimeVendor(db);
    if (!realtimeProviderFor(vendor).capabilities.speakerLabels) {
      return { sessionSpeakers: [], labelsSupported: false, updatedAt: new Date().toISOString() };
    }

    const result = await db.query('meeting_speakers', 'room', {
      where: [{ field: 'meeting', op: '==', value: meetingId }],
      limit: 1000,
    });
    const sessionSpeakers: LiveSpeakerDto[] = extractDbRecords(result)
      .filter((row) => typeof row.sessionSpeakerId === 'string' && row.sessionSpeakerId)
      .map((row) => ({
        sessionSpeakerId: row.sessionSpeakerId as string,
        sonioxLabels: asStringArray(row.sonioxLabels),
        displayName: typeof row.displayName === 'string' && row.displayName ? row.displayName : undefined,
        profileId: typeof row.profileId === 'string' && row.profileId ? row.profileId : undefined,
        liveConfidence: typeof row.liveConfidence === 'number' ? row.liveConfidence : undefined,
        liveSpeechSec: typeof row.liveSpeechSec === 'number' ? row.liveSpeechSec : 0,
        colorKey: typeof row.colorKey === 'string' && row.colorKey ? row.colorKey : 'blue',
        resolved: row.resolved === true,
      }));

    // `mergedInto` is not a stored field — it only exists in-process, on the
    // registry, for the brief window between a merge and the next
    // `upsertAll`, which now DELETES the loser's `meeting_speakers` row
    // outright (`live-speaker-repository.ts`). So this is a short-window
    // nicety only: it lets the UI hide the loser immediately, before that
    // delete lands, when this process happens to be running that meeting's
    // worker. A miss (different pm2 worker, or the delete already landed)
    // just means the loser row is already gone from the query above, or the
    // UI waits for the next poll after the merge fully lands in App DB.
    const registry = sessionRegistries.has(meetingId) ? sessionRegistries.get(meetingId) : null;
    const mergedIntoBySessionId = new Map(registry ? registry.snapshot().map((s) => [s.sessionSpeakerId, s.mergedInto]) : []);
    for (const speaker of sessionSpeakers) {
      const mergedInto = mergedIntoBySessionId.get(speaker.sessionSpeakerId);
      if (mergedInto) speaker.mergedInto = mergedInto;
    }

    const degraded = registry?.isDegraded() ?? false;

    return {
      sessionSpeakers,
      degraded: degraded || undefined,
      labelsSupported: true,
      updatedAt: new Date().toISOString(),
    };
  },
};
