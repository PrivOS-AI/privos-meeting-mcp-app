/**
 * `meeting_chunk_ready {roomId, meetingId, seq, durationMs, segments[]}` —
 * P5: authorizes the caller, validates the shape/bounds of the turns
 * uploaded for one part (structural checks only — the audio-aware span
 * window + RMS silence checks run inside `live-speakers/chunk-worker.ts`,
 * once it actually has the decoded PCM to check against), then enqueues the
 * chunk worker and returns `{accepted:true}` immediately. Processing itself
 * (embedding, matching, `meeting_speakers`/`live-turns.json` writes) happens
 * asynchronously behind `keyed-serial-queue.ts` — losing that work only
 * delays live labels, never blocks/corrupts the recording itself.
 *
 * Degraded mode (D-18): a meeting whose realtime provider does not support
 * speaker labels (currently: `elevenlabs-realtime`) never gets a real chunk
 * enqueued — the iframe should not even be calling this for such a meeting,
 * but a stray/forced call is answered with `{accepted:false,
 * reason:'labels_not_supported'}` rather than an error.
 */
import { AppError } from '../../shared/app-error.js';
import { AppDbBotClient } from '../hub/app-db-bot-client.js';
import { enqueueChunk } from '../live-speakers/chunk-worker.js';
import { resolveRealtimeVendor, realtimeProviderFor } from '../stt/stt-provider-registry.js';
import { asChunkSegment, assertStructuralSpans, type ChunkSegment } from './span-validation.js';
import type { AppTool } from './registry.js';

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export const chunkReadyTool: AppTool = {
  name: 'meeting_chunk_ready',
  title: 'Report recording part ready',
  description: 'Receive and validate the turns of a just-uploaded recording part.',
  inputSchema: {
    type: 'object',
    required: ['roomId', 'meetingId', 'seq', 'durationMs', 'segments'],
    properties: {
      roomId: { type: 'string' },
      meetingId: { type: 'string' },
      seq: { type: 'number' },
      durationMs: { type: 'number' },
      // New, optional: the client's absolute part-boundary stamp
      // (`performance.now() - recorderEpochMs` at blob-emit time). Absent for
      // an older tab still open across a deploy — the worker falls back to
      // its own cumulative clock for that meeting; see `chunk-worker.ts`.
      partStartMs: { type: 'number' },
      segments: { type: 'array', items: { type: 'object' } },
    },
  },
  async execute(args, context, runtime) {
    const arrivedAtMs = Date.now(); // diagnostics only (`uploadLagMs`) — captured before any DB round-trip below.
    const roomId = asString(args.roomId);
    const meetingId = asString(args.meetingId);
    const seq = Number(args.seq);
    const durationMs = Number(args.durationMs);
    // Only a TYPE/shape check here — a well-typed but suspicious value (out of
    // bounds, non-monotonic, breaks continuity) is not a malformed call; it is
    // validated (and, on violation, skipped + logged) once the chunk worker
    // has this meeting's registry to compare against (`validatePartStamp`).
    const partStartMsRaw = args.partStartMs;
    const partStartMs = partStartMsRaw === undefined || partStartMsRaw === null ? undefined : Number(partStartMsRaw);
    if (
      !roomId ||
      !meetingId ||
      !Number.isInteger(seq) ||
      seq < 0 ||
      !Number.isFinite(durationMs) ||
      durationMs <= 0 ||
      (partStartMs !== undefined && !Number.isFinite(partStartMs))
    ) {
      throw new AppError('Invalid meeting_chunk_ready parameters.');
    }

    const actor = context.actor;
    if (!actor || actor.roomId !== roomId) {
      throw new AppError('Invalid request for this room.');
    }

    const db = new AppDbBotClient(roomId);
    const meeting = await db.getById('meetings', 'room', meetingId);
    if (!meeting || meeting.roomId !== roomId) {
      throw new AppError('Meeting not found in this room.');
    }
    if (meeting.ownerUserId !== actor.userId) {
      throw new AppError('Only the meeting owner can send meeting_chunk_ready.');
    }
    if (meeting.status !== 'recording' && meeting.status !== 'uploading') {
      throw new AppError('Meeting is not in a state that accepts recording parts.');
    }

    const vendor = await resolveRealtimeVendor(db);
    if (!realtimeProviderFor(vendor).capabilities.speakerLabels) {
      // D-18 degraded mode — not an error, just nothing to do.
      return { accepted: false, reason: 'labels_not_supported' };
    }

    const segmentsRaw = Array.isArray(args.segments) ? args.segments : [];
    const segments = segmentsRaw.map(asChunkSegment).filter((s): s is ChunkSegment => s !== null);
    if (segments.length !== segmentsRaw.length) {
      throw new AppError('Some turns contain invalid data.');
    }
    const structuralError = assertStructuralSpans(segments, durationMs);
    if (structuralError) throw new AppError(structuralError);

    const folderId = typeof meeting.folderId === 'string' && meeting.folderId ? meeting.folderId : '';
    if (!folderId) throw new AppError('Meeting has no storage folder yet.');

    enqueueChunk({ db, hub: runtime.agentBotHub, folderId }, { roomId, meetingId, seq, durationMs, partStartMs, arrivedAtMs, segments });

    return { accepted: true };
  },
};
