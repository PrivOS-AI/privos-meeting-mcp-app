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
  ownerUserId?: string;
  folderId?: string;
  language?: string;
  translationEnabled?: boolean;
  audioFileId?: string;
  transcriptJsonFileId?: string;
  transcriptMdFileId?: string;
  srtFileId?: string;
  summaryFileId?: string;
  summaryText?: string;
  summaryError?: string;
  keyTopics?: string[];
  sentToChatAt?: string;
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
    ownerUserId: typeof record.ownerUserId === 'string' ? record.ownerUserId : undefined,
    folderId: typeof record.folderId === 'string' ? record.folderId : undefined,
    language: typeof record.language === 'string' ? record.language : undefined,
    translationEnabled: typeof record.translationEnabled === 'boolean' ? record.translationEnabled : undefined,
    audioFileId: typeof record.audioFileId === 'string' ? record.audioFileId : undefined,
    transcriptJsonFileId: typeof record.transcriptJsonFileId === 'string' ? record.transcriptJsonFileId : undefined,
    transcriptMdFileId: typeof record.transcriptMdFileId === 'string' ? record.transcriptMdFileId : undefined,
    srtFileId: typeof record.srtFileId === 'string' ? record.srtFileId : undefined,
    summaryFileId: typeof record.summaryFileId === 'string' ? record.summaryFileId : undefined,
    summaryText: typeof record.summaryText === 'string' ? record.summaryText : undefined,
    summaryError: typeof record.summaryError === 'string' ? record.summaryError : undefined,
    keyTopics: Array.isArray(record.keyTopics) ? record.keyTopics.filter((t): t is string => typeof t === 'string') : undefined,
    sentToChatAt: typeof record.sentToChatAt === 'string' ? record.sentToChatAt : undefined,
  };
}

/** One meeting's current stored state, or `null` when it does not exist. */
export async function getMeeting(app: McpApp, meetingId: string): Promise<MeetingReadModel | null> {
  const record = await new AppDbClient(app).get('meetings', meetingId);
  return record ? asMeetingReadModel(record) : null;
}

export type MeetingOrderBy = 'startedAt_desc' | 'startedAt_asc' | 'durationSec_desc';

export interface ListMeetingsOptions {
  limit?: number;
  offset?: number;
  orderBy?: MeetingOrderBy;
}

export interface ListMeetingsResult {
  meetings: MeetingReadModel[];
  total: number;
}

const MAX_PAGE_SIZE = 200; // App DB's own `mcpapp.db.query` cap is 1000; the history screen pages 50 at a time (phase-07 § Requirements).

/** One page of a room's meetings — always paginated, never an unbounded query (phase-07 risk table: "`db.query` limit 1000 làm thiếu dữ liệu"). */
export async function listMeetings(app: McpApp, roomId: string, options: ListMeetingsOptions = {}): Promise<ListMeetingsResult> {
  const limit = Math.min(options.limit ?? 50, MAX_PAGE_SIZE);
  const field = options.orderBy === 'durationSec_desc' ? 'durationSec' : 'startedAt';
  const direction = options.orderBy === 'startedAt_asc' ? 'asc' : 'desc';
  const { records, total } = await new AppDbClient(app).query({
    collection: 'meetings',
    where: [{ field: 'roomId', op: '==', value: roomId }],
    orderBy: [{ field, direction }],
    limit,
    offset: options.offset ?? 0,
  });
  return { meetings: records.map(asMeetingReadModel), total };
}

/** Iframe-owned field — same write this app already performs elsewhere for the title (plan.md field-ownership table). */
export async function renameMeeting(app: McpApp, meetingId: string, title: string): Promise<void> {
  await new AppDbClient(app).update('meetings', meetingId, { title });
}

/**
 * Deletes a meeting's row and its stored Files artifacts. Child rows
 * (`meeting_speakers`, `action_items`, `bookmarks`) carry a `meeting`
 * reference field registered with `onDelete:'cascade'`
 * (`shared/app-db-schema.ts`), so the Hub removes them automatically — this
 * function does not delete them itself. File deletion is best-effort (a
 * file already gone, or storage the user lacks rights to, must not block the
 * record delete the user explicitly confirmed).
 */
export async function deleteMeeting(app: McpApp, meeting: MeetingReadModel): Promise<void> {
  const fileIds = [meeting.audioFileId, meeting.transcriptJsonFileId, meeting.transcriptMdFileId, meeting.srtFileId, meeting.summaryFileId].filter(
    (id): id is string => Boolean(id),
  );
  await Promise.all(fileIds.map((id) => app.rest({ method: 'DELETE', path: `file-management.files/${id}` }).catch(() => undefined)));
  await new AppDbClient(app).delete('meetings', meeting._id);
}

export interface MeetingSpeakerSummary {
  speakerId: string;
  displayName: string;
  colorKey: string;
}

/**
 * Batched lookup of each meeting's speakers for the current history page —
 * one `where: meeting in [...]` query instead of one query per row, so
 * showing avatars in the table never turns into N+1 requests.
 */
export async function listSpeakersForMeetings(app: McpApp, meetingIds: readonly string[]): Promise<Record<string, MeetingSpeakerSummary[]>> {
  if (meetingIds.length === 0) return {};
  const { records } = await new AppDbClient(app).query({
    collection: 'meeting_speakers',
    where: [{ field: 'meeting', op: 'in', value: [...meetingIds] }],
    limit: 1000,
  });
  const byMeeting: Record<string, MeetingSpeakerSummary[]> = {};
  for (const record of records) {
    const meetingId = String(record.meeting ?? '');
    if (!meetingId) continue;
    const displayName = typeof record.displayName === 'string' && record.displayName ? record.displayName : String(record.speakerId ?? '?');
    (byMeeting[meetingId] ??= []).push({
      speakerId: String(record.speakerId ?? ''),
      displayName,
      colorKey: typeof record.colorKey === 'string' && record.colorKey ? record.colorKey : 'blue',
    });
  }
  return byMeeting;
}

/**
 * Which meetings on the current page have at least one bookmark — backs the
 * "Đã bookmark" history filter chip. One batched `in` query per page,
 * applied client-side (phase-07 § Requirements accepts this as a documented
 * client-side approximation over the current page, same as keyword search).
 */
export async function listMeetingIdsWithBookmarks(app: McpApp, meetingIds: readonly string[]): Promise<Set<string>> {
  if (meetingIds.length === 0) return new Set();
  const { records } = await new AppDbClient(app).query({
    collection: 'bookmarks',
    where: [{ field: 'meeting', op: 'in', value: [...meetingIds] }],
    limit: 1000,
  });
  return new Set(records.map((r) => String(r.meeting ?? '')).filter(Boolean));
}

export interface ActionItemCounts {
  total: number;
  open: number;
}

/** Batched action-item totals per meeting — backs the "số action" column and the "Có action item" filter chip. */
export async function listActionItemCountsForMeetings(app: McpApp, meetingIds: readonly string[]): Promise<Record<string, ActionItemCounts>> {
  if (meetingIds.length === 0) return {};
  const { records } = await new AppDbClient(app).query({
    collection: 'action_items',
    where: [{ field: 'meeting', op: 'in', value: [...meetingIds] }],
    limit: 1000,
  });
  const byMeeting: Record<string, ActionItemCounts> = {};
  for (const record of records) {
    const meetingId = String(record.meeting ?? '');
    if (!meetingId) continue;
    const counts = (byMeeting[meetingId] ??= { total: 0, open: 0 });
    counts.total += 1;
    if (record.done !== true) counts.open += 1;
  }
  return byMeeting;
}
