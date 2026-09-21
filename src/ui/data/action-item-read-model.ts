/**
 * Iframe read + limited write access to `action_items` (phase-06 § Related
 * Code Files). The backend job writes the rows via
 * `meeting-repository.replaceActionItems` (idempotent, authoritative content);
 * this module only ever reads them for display and toggles `done` /
 * `listItemId` — both user-context writes the manifest's `db:write` grant
 * already covers (plan.md field-ownership table: iframe may tick done, never
 * rewrite task/owner/due).
 */
import type { McpApp } from '@privos_ai/app-react';

import { AppDbClient } from './app-db-client.js';

export interface ActionItemRecord {
  id: string;
  meetingId: string;
  task: string;
  owner: string | null;
  due: string | null;
  atSec: number | null;
  done: boolean;
  listItemId: string | null;
}

function asActionItem(record: { _id: string; [key: string]: unknown }): ActionItemRecord {
  return {
    id: record._id,
    meetingId: String(record.meeting ?? ''),
    task: typeof record.task === 'string' ? record.task : '',
    owner: typeof record.owner === 'string' && record.owner ? record.owner : null,
    due: typeof record.due === 'string' && record.due ? record.due : null,
    atSec: typeof record.atSec === 'number' ? record.atSec : null,
    done: record.done === true,
    listItemId: typeof record.listItemId === 'string' && record.listItemId ? record.listItemId : null,
  };
}

/** Every action item for one meeting, in creation order. */
export async function listActionItems(app: McpApp, meetingId: string): Promise<ActionItemRecord[]> {
  const { records } = await new AppDbClient(app).query({
    collection: 'action_items',
    where: [{ field: 'meeting', op: '==', value: meetingId }],
    limit: 1000,
  });
  return records.map(asActionItem);
}

export async function toggleActionItemDone(app: McpApp, id: string, done: boolean): Promise<void> {
  await new AppDbClient(app).update('action_items', id, { done });
}

/** Recorded after a successful "Push to Smart List" so a re-push skips this item (idempotency). */
export async function setActionItemListItemId(app: McpApp, id: string, listItemId: string): Promise<void> {
  await new AppDbClient(app).update('action_items', id, { listItemId });
}
