/**
 * A finished meeting's `transcript.json`, read back from Files as the bot,
 * with each speaker's CURRENT name: `meeting_speakers` may have been corrected
 * (`speaker_resolve`, live renames) since the job froze names into the file.
 * Shared by `meeting_summarize` and `meeting_ask`.
 */
import { text as streamToText } from 'node:stream/consumers';
import type { RoomBoundHubClient } from '@privos_ai/app-server';

import { AppError } from '../../shared/app-error.js';
import { extractDbRecords, type AppDbBotClient, type DbRow } from '../hub/app-db-bot-client.js';
import { fetchFileReadable } from '../media/hub-file-download.js';
import type { TranscriptJson } from './transcript-json.js';

export interface StoredTranscript {
  doc: TranscriptJson;
  /** speakerId -> the name to show now. */
  displayNameBySpeaker: Record<string, string>;
}

function isTranscriptJson(value: unknown): value is TranscriptJson {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return Array.isArray(record.segments) && Array.isArray(record.tokens) && Array.isArray(record.speakers);
}

export async function loadStoredTranscript(db: AppDbBotClient, hub: RoomBoundHubClient, meeting: DbRow): Promise<StoredTranscript> {
  if (!meeting.transcriptJsonFileId || typeof meeting.transcriptJsonFileId !== 'string') {
    throw new AppError('Meeting has no transcript yet.', 'INVALID_STATE');
  }
  const raw = await streamToText(await fetchFileReadable(hub, meeting.transcriptJsonFileId));
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    throw new AppError('Could not read transcript.json — invalid file.', 'INVALID_INPUT');
  }
  if (!isTranscriptJson(doc)) throw new AppError('transcript.json is not in the expected format.', 'INVALID_INPUT');

  const speakerRows = extractDbRecords(
    await db.query('meeting_speakers', 'room', { where: [{ field: 'meeting', op: '==', value: meeting._id }], limit: 1000 }),
  );
  const displayNameBySpeaker: Record<string, string> = {};
  for (const row of speakerRows) {
    if (typeof row.speakerId === 'string' && typeof row.displayName === 'string' && row.displayName) {
      displayNameBySpeaker[row.speakerId] = row.displayName;
    }
  }
  for (const s of doc.speakers) {
    if (!displayNameBySpeaker[s.speakerId] && s.displayName) displayNameBySpeaker[s.speakerId] = s.displayName;
  }
  return { doc, displayNameBySpeaker };
}
