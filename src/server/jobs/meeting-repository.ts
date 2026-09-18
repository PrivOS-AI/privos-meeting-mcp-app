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
}

/** One row per `speakerId` for the meeting — idempotent: updates the existing row when present, else creates one. */
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

    const row = bySpeakerId.get(speaker.speakerId);
    if (row) await db.update('meeting_speakers', 'room', row._id, data);
    else await db.create('meeting_speakers', 'room', data);
  }
}

export interface ActionItemInput {
  task: string;
  owner?: string;
  due?: string;
  atSec?: number;
}

/**
 * Creates the given action items for the meeting. True "replace" (deleting
 * stale rows from a re-run) needs a `db.delete` capability `AppDbBotClient`
 * does not expose yet — P6, which is the only phase that calls this with a
 * non-empty list, tracks that as a follow-up. P3 never calls this with items
 * (the summarize hook is a stub), so the seam is exercised as a no-op here.
 */
export async function replaceActionItems(db: AppDbBotClient, meetingId: string, items: readonly ActionItemInput[]): Promise<void> {
  for (const item of items) {
    await db.create('action_items', 'room', { meeting: meetingId, task: item.task, owner: item.owner, due: item.due, atSec: item.atSec, done: false });
  }
}
