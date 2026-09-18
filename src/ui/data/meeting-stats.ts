/**
 * History screen's 4 stat cards, computed via `mcpapp.db.count`/`aggregate`
 * (phase-07 § Architecture / Requirements) — never pages full record sets
 * just to count or sum them. `action_items`/`bookmarks` are `scope:'room'`
 * collections (physically isolated per room on the Hub —
 * `tools-database.md`'s `app_{appId}_{roomId}_{collection}`), so counting
 * them needs no explicit `roomId` filter; `meetings` is filtered explicitly
 * to match this app's existing `meeting-read-model.ts` convention.
 */
import type { McpApp } from '@privos_ai/app-react';

import { AppDbClient } from './app-db-client.js';

export interface MeetingStats {
  meetingsThisWeek: number;
  totalDurationSec: number;
  openActionItems: number;
  bookmarkCount: number;
}

/** Monday 00:00 local time of the week containing `now` — "tuần này" (the spec leaves the exact week-start convention to the implementation). */
export function startOfWeekIso(now: Date = new Date()): string {
  const day = now.getDay(); // 0 = Sunday .. 6 = Saturday
  const diffToMonday = (day + 6) % 7;
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - diffToMonday, 0, 0, 0, 0);
  return monday.toISOString();
}

function asAggregateNumber(result: number | Array<{ _id: unknown; result: number }>): number {
  return typeof result === 'number' && Number.isFinite(result) ? result : 0;
}

export async function loadMeetingStats(app: McpApp, roomId: string, now: Date = new Date()): Promise<MeetingStats> {
  const db = new AppDbClient(app);
  const weekStart = startOfWeekIso(now);

  const [thisWeek, durationAgg, openItems, bookmarks] = await Promise.all([
    db.count({
      collection: 'meetings',
      where: [
        { field: 'roomId', op: '==', value: roomId },
        { field: 'startedAt', op: '>=', value: weekStart },
      ],
    }),
    db.aggregate({ collection: 'meetings', op: 'sum', field: 'durationSec', where: [{ field: 'roomId', op: '==', value: roomId }] }),
    db.count({ collection: 'action_items', where: [{ field: 'done', op: '==', value: false }] }),
    db.count({ collection: 'bookmarks' }),
  ]);

  return {
    meetingsThisWeek: thisWeek.count,
    totalDurationSec: asAggregateNumber(durationAgg.result),
    openActionItems: openItems.count,
    bookmarkCount: bookmarks.count,
  };
}
