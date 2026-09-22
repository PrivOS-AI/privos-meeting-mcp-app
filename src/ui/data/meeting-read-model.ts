/**
 * Read-only iframe access to a meeting's processing state and stored
 * transcript file ids — the counterpart to `meeting-draft-repository.ts`'s
 * writes. Every write to these same fields happens server-side (see
 * `src/server/jobs/meeting-repository.ts` and the `meeting_status` tool); the
 * iframe never writes them. History/detail screens (P7) build on this.
 */
import type { McpApp } from '@privos_ai/app-react';

import { AppDbClient } from './app-db-client.js';
import { unwrapRestBody } from './rest-body.js';

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

/** One page of a room's meetings — always paginated, never an unbounded query (phase-07 risk table: "`db.query` limit 1000 causes missing data"). */
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
 * Deletes a meeting's row plus everything it stored in Files: every file
 * inside the meeting's folder (the tracked artifacts AND any leftover
 * `audio.part-*` chunks from an interrupted/unprocessed session), then the
 * now-empty folder itself.
 *
 * Child rows (`meeting_speakers`, `action_items`, `bookmarks`) carry a
 * `meeting` reference field registered with `onDelete:'cascade'`
 * (`shared/app-db-schema.ts`), so the Hub removes them automatically.
 *
 * All Files cleanup is best-effort — a file already gone, an unsupported
 * folder-delete endpoint, or storage the user lacks rights to must never
 * block the record delete the user explicitly confirmed. The DB row is
 * removed last regardless.
 */
export async function deleteMeeting(app: McpApp, meeting: MeetingReadModel): Promise<void> {
  // Remove every file still living in the meeting's folder — this is what
  // clears untracked audio parts the tracked-id list below never knew about.
  if (meeting.folderId && meeting.roomId) {
    await deleteFolderFiles(app, meeting.roomId, meeting.folderId).catch(() => undefined);
  }

  // Belt-and-braces: always delete the known artifacts too, so a skipped or
  // partial folder listing (missing folderId, permission hiccup) still removes
  // them. Files already gone return 404, which is swallowed.
  const trackedIds = [meeting.audioFileId, meeting.transcriptJsonFileId, meeting.transcriptMdFileId, meeting.srtFileId, meeting.summaryFileId].filter(
    (id): id is string => Boolean(id),
  );
  await Promise.all(trackedIds.map((id) => app.rest({ method: 'DELETE', path: `file-management.files/${id}` }).catch(() => undefined)));

  // Best-effort remove the emptied folder record. The Hub file API only ever
  // exposes folder create/list to this app; a folder DELETE mirrors the
  // `files/<id>` shape but may be unsupported — if so, an empty folder is left
  // behind rather than failing the whole delete.
  if (meeting.folderId) {
    await app.rest({ method: 'DELETE', path: `file-management.folders/${meeting.folderId}` }).catch(() => undefined);
  }

  await new AppDbClient(app).delete('meetings', meeting._id);
}

interface FolderFileRecord {
  _id: string;
}

/**
 * Delete every file directly inside `folderId`. Lists in passes of 100 and
 * deletes what it lists, re-listing until the folder is empty. A pass that
 * deletes nothing (undeletable file) or an iteration cap breaks the loop so a
 * persistent failure can never spin forever.
 */
async function deleteFolderFiles(app: McpApp, roomId: string, folderId: string): Promise<void> {
  for (let pass = 0; pass < 30; pass++) {
    const listed = await app.rest({ method: 'GET', path: `file-management.files.channel/${roomId}`, query: { folderId, count: 100 } });
    const { files } = unwrapRestBody<{ files?: unknown }>(listed);
    const records = Array.isArray(files) ? (files as FolderFileRecord[]) : [];
    if (records.length === 0) return;
    let deleted = 0;
    await Promise.all(
      records.map(async (file) => {
        try {
          await app.rest({ method: 'DELETE', path: `file-management.files/${file._id}` });
          deleted += 1;
        } catch {
          // best-effort — leave the file, the progress guard below bails out
        }
      }),
    );
    if (deleted === 0) return;
  }
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
 * "Bookmarked" history filter chip. One batched `in` query per page,
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

/** Batched action-item totals per meeting — backs the "action count" column and the "Has action item" filter chip. */
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
