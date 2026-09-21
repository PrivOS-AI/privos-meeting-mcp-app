/**
 * Iframe-side (user-context) writes to `meetings` and `bookmarks` while
 * recording. Everything else about `meetings` (processing status, file ids,
 * summary) is backend-only (see plan.md's field-ownership table) — this
 * module only ever writes the fields the recording UI itself owns.
 */
import type { McpApp } from '@privos_ai/app-react';

import { AppDbClient } from './app-db-client.js';
import type { SttSessionMeta } from './meeting-clock.js';

export interface CreateMeetingInput {
  roomId: string;
  /** Omitted at create time — the real `meetingId` (App-DB-assigned) is needed to name the folder first. Patch it in via `updateRecordingMeeting`. */
  folderId?: string;
  title: string;
  slug: string;
  language: string;
  translationEnabled: boolean;
  translationLang?: string;
  keepAudio: boolean;
  ownerUserId: string;
  startedAt: string;
}

/** Creates the `meetings` row iframe-side, `status:'recording'`, `partCount:0`. */
export async function createMeeting(app: McpApp, input: CreateMeetingInput): Promise<{ meetingId: string }> {
  const db = new AppDbClient(app);
  const created = await db.create('meetings', {
    roomId: input.roomId,
    ...(input.folderId ? { folderId: input.folderId } : {}),
    title: input.title,
    slug: input.slug,
    language: input.language,
    translationEnabled: input.translationEnabled,
    translationLang: input.translationLang,
    keepAudio: input.keepAudio,
    ownerUserId: input.ownerUserId,
    startedAt: input.startedAt,
    status: 'recording',
    partCount: 0,
  });
  return { meetingId: created._id };
}

export interface RecordingMeetingUpdate {
  title?: string;
  folderId?: string;
  partCount?: number;
  lastPartAt?: string;
  sttSessionMeta?: SttSessionMeta;
  endedAt?: string;
  durationSec?: number;
  status?: 'recording' | 'uploading' | 'interrupted' | 'failed';
}

/** Iframe-owned fields only — see plan.md's field-ownership table for what is backend-only. */
export async function updateRecordingMeeting(app: McpApp, meetingId: string, patch: RecordingMeetingUpdate): Promise<void> {
  const data: Record<string, unknown> = { ...patch };
  if (patch.sttSessionMeta) data.sttSessionMeta = JSON.stringify(patch.sttSessionMeta);
  await new AppDbClient(app).update('meetings', meetingId, data);
}

export interface AddBookmarkInput {
  meetingId: string;
  atSec: number;
  quote?: string;
  createdBy: string;
}

export async function addBookmark(app: McpApp, input: AddBookmarkInput): Promise<{ bookmarkId: string }> {
  const created = await new AppDbClient(app).create('bookmarks', {
    meeting: input.meetingId,
    atSec: input.atSec,
    quote: input.quote,
    createdBy: input.createdBy,
  });
  return { bookmarkId: created._id };
}

export interface ActiveRecordingMeeting {
  _id: string;
  title?: string;
  status: string;
  partCount?: number;
  folderId?: string;
  startedAt?: string;
  endedAt?: string;
}

/** Meetings owned by the current user that look abandoned — drives the recovery banner. */
export async function listActiveRecordingMeetings(app: McpApp, roomId: string, ownerUserId: string): Promise<ActiveRecordingMeeting[]> {
  const { records } = await new AppDbClient(app).query({
    collection: 'meetings',
    where: [
      { field: 'roomId', op: '==', value: roomId },
      { field: 'ownerUserId', op: '==', value: ownerUserId },
      { field: 'status', op: 'in', value: ['recording', 'interrupted'] },
    ],
    limit: 20,
  });
  return (records as unknown as ActiveRecordingMeeting[]).filter((m) => !m.endedAt);
}
