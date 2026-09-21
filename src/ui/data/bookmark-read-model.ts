/**
 * Iframe read/write access to `bookmarks` for the (P7) meeting detail screen
 * and the (P6) live side panel — a separate module from
 * `meeting-draft-repository.ts`'s `addBookmark` (that one is scoped to the
 * live-recording write path P2 already owns); this one covers listing,
 * post-meeting adding and deleting, all fields the manifest's `db:write`
 * grant already covers for a room member.
 */
import type { McpApp } from '@privos_ai/app-react';

import { AppDbClient } from './app-db-client.js';

export interface BookmarkRecord {
  id: string;
  meetingId: string;
  atSec: number;
  quote?: string;
  createdBy?: string;
}

function asBookmark(record: { _id: string; [key: string]: unknown }): BookmarkRecord {
  return {
    id: record._id,
    meetingId: String(record.meeting ?? ''),
    atSec: typeof record.atSec === 'number' ? record.atSec : 0,
    quote: typeof record.quote === 'string' && record.quote ? record.quote : undefined,
    createdBy: typeof record.createdBy === 'string' ? record.createdBy : undefined,
  };
}

/** Every bookmark for one meeting, ordered by time. */
export async function listBookmarks(app: McpApp, meetingId: string): Promise<BookmarkRecord[]> {
  const { records } = await new AppDbClient(app).query({
    collection: 'bookmarks',
    where: [{ field: 'meeting', op: '==', value: meetingId }],
    orderBy: [{ field: 'atSec', direction: 'asc' }],
    limit: 1000,
  });
  return records.map(asBookmark);
}

export async function addBookmarkAt(app: McpApp, meetingId: string, atSec: number, createdBy: string, quote?: string): Promise<void> {
  await new AppDbClient(app).create('bookmarks', { meeting: meetingId, atSec, createdBy, ...(quote ? { quote } : {}) });
}

export async function deleteBookmark(app: McpApp, bookmarkId: string): Promise<void> {
  await new AppDbClient(app).delete('bookmarks', bookmarkId);
}
