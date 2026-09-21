/**
 * `meeting_live_speakers {roomId, meetingId, sinceMs?}` — polled by the
 * iframe every 4s while recording (`live-speaker-poll.ts`). Room-member authz
 * only (any participant may see who is currently talking, not just the
 * owner). `sessionSpeakers` still reads straight from `meeting_speakers`;
 * `turns` reads the in-process registry's RETAINED turns buffer via
 * `ensureRegistry`/`turnsSince` — this DOES now touch the registry every
 * poll (unlike before phase 8), but only an in-memory read: it never re-reads
 * `live-turns.json` from Files except the ONE TIME `ensureRegistry` rebuilds
 * a registry that does not exist yet in this process (a restart, or a poll
 * landing on a different pm2 instance than the one running the chunk
 * worker) — see `MeetingSessionRegistry#hasHydratedTurns`.
 *
 * DTO allowlist ONLY: never `pendingEmbedding`, never a raw vector — a test
 * asserts the response has no such field. `turns` carries only
 * `{startMs,endMs,label,sessionSpeakerId}` — also vector/text-free.
 * `degraded:true` once any chunk for this meeting has been dropped/failed;
 * `labelsSupported:false` short-circuits to an empty list when the meeting's
 * realtime provider never had labels to begin with (D-18) so the iframe can
 * stop polling.
 */
import { AppError } from '../../shared/app-error.js';
import { AppDbBotClient, extractDbRecords } from '../hub/app-db-bot-client.js';
import { resolveRealtimeVendor, realtimeProviderFor } from '../stt/stt-provider-registry.js';
import { ensureRegistry } from '../live-speakers/live-speaker-repository.js';
import { requireRoomMeeting, requireVerifiedActor } from './authz.js';
import type { AppTool } from './registry.js';

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** `undefined` when the caller omitted `sinceMs`; throws on anything present but not a finite, non-negative number — no silent clamp (plan.md, matching phase 2's client-input stance). */
function parseSinceMs(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new AppError('sinceMs must be a finite number >= 0 when provided.');
  }
  return value;
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

/** One settled turn — the server's own per-turn identity decision, vector/text-free by construction (it is just a time span + two ids). */
export interface LiveTurnDto {
  startMs: number;
  endMs: number;
  label: string;
  sessionSpeakerId: string;
}

export const liveSpeakersTool: AppTool = {
  name: 'meeting_live_speakers',
  title: 'Live speakers',
  description: 'List of speakers detected during the meeting, with names when matched to a voiceprint profile.',
  inputSchema: {
    type: 'object',
    required: ['roomId', 'meetingId'],
    properties: {
      roomId: { type: 'string' },
      meetingId: { type: 'string' },
      sinceMs: { type: 'number', description: 'Only return settled turns newer than this meeting-clock timestamp. Omitted -> the most recent turns.' },
    },
  },
  async execute(args, context, runtime) {
    const actor = requireVerifiedActor(context);
    const roomId = asString(args.roomId);
    const meetingId = asString(args.meetingId);
    if (!roomId || !meetingId) throw new AppError('roomId and meetingId are required.');
    const sinceMs = parseSinceMs(args.sinceMs);

    const db = new AppDbBotClient(roomId);
    const meeting = await requireRoomMeeting(db, actor, roomId, meetingId);

    const vendor = await resolveRealtimeVendor(db);
    if (!realtimeProviderFor(vendor).capabilities.speakerLabels) {
      return { sessionSpeakers: [], turns: [], labelsSupported: false, updatedAt: new Date().toISOString() };
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

    const folderId = typeof meeting.folderId === 'string' ? meeting.folderId : '';
    const registry = await ensureRegistry(db, meetingId, runtime.agentBotHub, roomId, folderId);

    // `mergedInto` reflects the registry's CURRENT in-memory state; the
    // persisted side of a merge (`upsertAll` deletes the loser's
    // `meeting_speakers` row outright) may not have landed yet, so this is a
    // short-window nicety that lets the UI hide the loser immediately rather
    // than waiting for that delete.
    const mergedIntoBySessionId = new Map(registry.snapshot().map((s) => [s.sessionSpeakerId, s.mergedInto]));
    for (const speaker of sessionSpeakers) {
      const mergedInto = mergedIntoBySessionId.get(speaker.sessionSpeakerId);
      if (mergedInto) speaker.mergedInto = mergedInto;
    }

    const { turns: settled, nextSinceMs } = registry.turnsSince(sinceMs);
    const turns: LiveTurnDto[] = settled.map((t) => ({ startMs: t.startMs, endMs: t.endMs, label: t.sonioxLabel, sessionSpeakerId: t.sessionSpeakerId }));

    return {
      sessionSpeakers,
      turns,
      nextSinceMs,
      degraded: registry.isDegraded() || undefined,
      labelsSupported: true,
      updatedAt: new Date().toISOString(),
    };
  },
};
