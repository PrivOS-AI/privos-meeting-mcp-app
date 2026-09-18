/**
 * Backend (bot-owned) writes to `meetings` / `meeting_speakers` / `action_items`
 * once a job has results — the counterpart to the iframe-owned fields in
 * `meeting-draft-repository.ts` (see plan.md's field-ownership table).
 */
import { extractDbRecords, type AppDbBotClient } from '../hub/app-db-bot-client.js';

export interface MeetingPatch {
  status?: 'processing' | 'summarized' | 'failed' | 'interrupted';
  audioFileId?: string;
  transcriptJsonFileId?: string;
  transcriptMdFileId?: string;
  srtFileId?: string;
  summaryFileId?: string;
  summaryText?: string;
  keyTopics?: string[];
  speakerCount?: number;
  audioDeletedAt?: string;
  sentToChatAt?: string;
  summaryError?: string;
  durationSec?: number;
}

/** Backend-owned `meetings` fields only — see plan.md's field-ownership table for what the iframe writes instead. */
export async function upsertMeeting(db: AppDbBotClient, meetingId: string, patch: MeetingPatch): Promise<void> {
  await db.update('meetings', 'room', meetingId, patch as Record<string, unknown>);
}

export interface SpeakerUpsertInput {
  speakerId: string;
  displayName?: string | null;
  nameSource?: 'user' | 'async' | 'live';
  totalSpeakSec?: number;
  confidence?: number;
  sampleStartSec?: number;
  sampleEndSec?: number;
  colorKey?: string;
  /** P4: the matched/enrolled profile, when resolved. */
  profileId?: string;
  resolved?: boolean;
  /** P4: sealed ciphertext (never a raw vector) awaiting `speaker_resolve` confirmation, or `''` to clear it. */
  pendingEmbedding?: string;
}

/**
 * One row per `speakerId` for the meeting — idempotent: updates the existing
 * row when present, else creates one. Writes ONLY the fields present on each
 * `SpeakerUpsertInput` (a partial `db.update`, never a full-document
 * replace), so P5's live-registry fields (`sessionSpeakerId`, `sonioxLabels`,
 * `liveConfidence`, `liveSpeechSec`, `liveUpdatedAt`) — none of which this
 * function ever sets — survive untouched when the async pass (P3/P4)
 * overwrites the SAME row (plan.md § Requirements, `meeting_speakers` merge
 * requirement).
 */
export async function upsertMeetingSpeakers(db: AppDbBotClient, meetingId: string, speakers: readonly SpeakerUpsertInput[]): Promise<void> {
  if (speakers.length === 0) return;
  const existingResult = await db.query('meeting_speakers', 'room', {
    where: [{ field: 'meeting', op: '==', value: meetingId }],
    limit: 1000,
  });
  const existing = extractDbRecords(existingResult);
  const bySpeakerId = new Map(existing.filter((row) => typeof row.speakerId === 'string').map((row) => [row.speakerId as string, row]));

  for (const speaker of speakers) {
    const data: Record<string, unknown> = {
      meeting: meetingId,
      speakerId: speaker.speakerId,
      nameSource: speaker.nameSource ?? 'async',
      totalSpeakSec: speaker.totalSpeakSec ?? 0,
    };
    if (speaker.displayName !== undefined) data.displayName = speaker.displayName;
    if (speaker.confidence !== undefined) data.confidence = speaker.confidence;
    if (speaker.sampleStartSec !== undefined) data.sampleStartSec = speaker.sampleStartSec;
    if (speaker.sampleEndSec !== undefined) data.sampleEndSec = speaker.sampleEndSec;
    if (speaker.colorKey !== undefined) data.colorKey = speaker.colorKey;
    if (speaker.profileId !== undefined) data.profileId = speaker.profileId;
    if (speaker.resolved !== undefined) data.resolved = speaker.resolved;
    if (speaker.pendingEmbedding !== undefined) data.pendingEmbedding = speaker.pendingEmbedding;

    const row = bySpeakerId.get(speaker.speakerId);
    if (row) await db.update('meeting_speakers', 'room', row._id, data);
    else await db.create('meeting_speakers', 'room', data);
  }
}

/** Priority rank for `nameSource` — higher wins (plan.md: "tên theo nameSource: user > async > live"). */
function nameSourceRank(nameSource: unknown): number {
  if (nameSource === 'user') return 3;
  if (nameSource === 'async') return 2;
  if (nameSource === 'live') return 1;
  return 0;
}

/**
 * Folds a LIVE-only `meeting_speakers` row (keyed by `sessionSpeakerId`,
 * written during the meeting by `live-speaker-repository.ts`) into the
 * matching ASYNC row (keyed by `speakerId`, written by this job) for the
 * SAME person — `reconcileWithLiveSpeakers` (`meeting-job.ts`) already
 * decided the two rows are the same person via `caption-aligner`'s
 * max-overlap alignment. Only ever ONE row per person survives: the async
 * row absorbs the live row's `sessionSpeakerId`/`sonioxLabels`/live metadata,
 * then the standalone live row is deleted. The NAME itself only moves from
 * live to async when the async row does not already have a higher-or-equal
 * priority name (`user` > `async` > `live`) — segmentation is always async's,
 * but an unresolved async speaker still gets a name from a live quick-assign
 * or live auto-match rather than staying "Người nói N" forever.
 */
export async function mergeLiveIntoAsyncSpeaker(db: AppDbBotClient, meetingId: string, speakerId: string, sessionSpeakerId: string): Promise<void> {
  const result = await db.query('meeting_speakers', 'room', { where: [{ field: 'meeting', op: '==', value: meetingId }], limit: 1000 });
  const rows = extractDbRecords(result);
  const asyncRow = rows.find((r) => r.speakerId === speakerId);
  if (!asyncRow) return;
  const liveRow = rows.find((r) => r.sessionSpeakerId === sessionSpeakerId && r._id !== asyncRow._id);

  const patch: Record<string, unknown> = { sessionSpeakerId };
  if (liveRow) {
    if (Array.isArray(liveRow.sonioxLabels)) patch.sonioxLabels = liveRow.sonioxLabels;
    if (typeof liveRow.liveSpeechSec === 'number') patch.liveSpeechSec = liveRow.liveSpeechSec;
    if (typeof liveRow.liveConfidence === 'number') patch.liveConfidence = liveRow.liveConfidence;
    if (typeof liveRow.liveUpdatedAt === 'string') patch.liveUpdatedAt = liveRow.liveUpdatedAt;

    if (nameSourceRank(liveRow.nameSource) > nameSourceRank(asyncRow.nameSource)) {
      if (typeof liveRow.displayName === 'string' && liveRow.displayName) patch.displayName = liveRow.displayName;
      if (typeof liveRow.nameSource === 'string') patch.nameSource = liveRow.nameSource;
      if (typeof liveRow.profileId === 'string' && liveRow.profileId) patch.profileId = liveRow.profileId;
      patch.resolved = true;
    }
  }

  await db.update('meeting_speakers', 'room', asyncRow._id, patch);
  if (liveRow) await db.delete('meeting_speakers', 'room', liveRow._id);
}

/**
 * Deletes every LIVE-only `meeting_speakers` row (has `sessionSpeakerId`, no
 * `speakerId`) whose `sessionSpeakerId` was NOT in `mappedSessionSpeakerIds`
 * — a session speaker the live registry opened but the async pass never
 * corroborated (noise, a false split, or someone who only spoke during a
 * part that failed to process). Async segmentation is authoritative
 * (plan.md), so an orphaned live guess does not get its own permanent row.
 */
export async function deleteUnmappedLiveSpeakers(db: AppDbBotClient, meetingId: string, mappedSessionSpeakerIds: ReadonlySet<string>): Promise<void> {
  const result = await db.query('meeting_speakers', 'room', { where: [{ field: 'meeting', op: '==', value: meetingId }], limit: 1000 });
  for (const row of extractDbRecords(result)) {
    const isLiveOnly = typeof row.sessionSpeakerId === 'string' && row.sessionSpeakerId && !(typeof row.speakerId === 'string' && row.speakerId);
    if (isLiveOnly && !mappedSessionSpeakerIds.has(row.sessionSpeakerId as string)) {
      await db.delete('meeting_speakers', 'room', row._id);
    }
  }
}

export interface ActionItemInput {
  task: string;
  owner?: string | null;
  due?: string | null;
  atSec?: number | null;
}

/**
 * True replace: deletes every existing `action_items` row for `meetingId`,
 * then creates the given list fresh. Idempotent across a job re-run (or a
 * `meeting_summarize` re-run) in the sense that matters most — it never
 * accumulates duplicates — at the accepted cost that `done`/`listItemId` on a
 * previous run's items do not carry over to a re-summarize (plan.md tracks
 * "Push to Smart List" idempotency separately, keyed by task text once
 * pushed again). `AppDbBotClient.delete` shipped in P4, closing the gap this
 * function used to have (P3's summarize stub never called it with items).
 */
export async function replaceActionItems(db: AppDbBotClient, meetingId: string, items: readonly ActionItemInput[]): Promise<void> {
  const existingResult = await db.query('action_items', 'room', {
    where: [{ field: 'meeting', op: '==', value: meetingId }],
    limit: 1000,
  });
  for (const row of extractDbRecords(existingResult)) {
    await db.delete('action_items', 'room', row._id);
  }
  for (const item of items) {
    await db.create('action_items', 'room', {
      meeting: meetingId,
      task: item.task,
      owner: item.owner ?? undefined,
      due: item.due ?? undefined,
      atSec: item.atSec ?? undefined,
      done: false,
    });
  }
}
