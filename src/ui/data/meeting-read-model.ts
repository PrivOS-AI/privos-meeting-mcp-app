/**
 * Read-only iframe access to a meeting's processing state and stored
 * transcript file ids — the counterpart to `meeting-draft-repository.ts`'s
 * writes. Every write to these same fields happens server-side (see
 * `src/server/jobs/meeting-repository.ts` and the `meeting_status` tool); the
 * iframe never writes them. History/detail screens (P7) build on this.
 */
import type { McpApp } from '@privos_ai/app-react';

import { AppDbClient } from './app-db-client.js';

export interface MeetingReadModel {
  _id: string;
  roomId: string;
  title?: string;
  status?: string;
  startedAt?: string;
  endedAt?: string;
  durationSec?: number;
  speakerCount?: number;
  audioFileId?: string;
  transcriptJsonFileId?: string;
  transcriptMdFileId?: string;
  srtFileId?: string;
  summaryFileId?: string;
  summaryText?: string;
  summaryError?: string;
}

function asMeetingReadModel(record: { _id: string; [key: string]: unknown }): MeetingReadModel {
  return {
    _id: record._id,
    roomId: String(record.roomId ?? ''),
    title: typeof record.title === 'string' ? record.title : undefined,
    status: typeof record.status === 'string' ? record.status : undefined,
    startedAt: typeof record.startedAt === 'string' ? record.startedAt : undefined,
    endedAt: typeof record.endedAt === 'string' ? record.endedAt : undefined,
    durationSec: typeof record.durationSec === 'number' ? record.durationSec : undefined,
    speakerCount: typeof record.speakerCount === 'number' ? record.speakerCount : undefined,
    audioFileId: typeof record.audioFileId === 'string' ? record.audioFileId : undefined,
    transcriptJsonFileId: typeof record.transcriptJsonFileId === 'string' ? record.transcriptJsonFileId : undefined,
    transcriptMdFileId: typeof record.transcriptMdFileId === 'string' ? record.transcriptMdFileId : undefined,
    srtFileId: typeof record.srtFileId === 'string' ? record.srtFileId : undefined,
    summaryFileId: typeof record.summaryFileId === 'string' ? record.summaryFileId : undefined,
    summaryText: typeof record.summaryText === 'string' ? record.summaryText : undefined,
    summaryError: typeof record.summaryError === 'string' ? record.summaryError : undefined,
  };
}

/** One meeting's current stored state, or `null` when it does not exist. */
export async function getMeeting(app: McpApp, meetingId: string): Promise<MeetingReadModel | null> {
  const record = await new AppDbClient(app).get('meetings', meetingId);
  return record ? asMeetingReadModel(record) : null;
}

/** Meetings for a room, most recent first — used by the (P7) history screen. */
export async function listMeetings(app: McpApp, roomId: string, limit = 50): Promise<MeetingReadModel[]> {
  const { records } = await new AppDbClient(app).query({
    collection: 'meetings',
    where: [{ field: 'roomId', op: '==', value: roomId }],
    orderBy: [{ field: 'startedAt', direction: 'desc' }],
    limit,
  });
  return records.map(asMeetingReadModel);
}
