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

export type ActionItemType = 'task' | 'request' | 'question';

export interface ActionItemRecord {
  id: string;
  meetingId: string;
  type: ActionItemType;
  task: string;
  /** Who does it. */
  owner: string | null;
  ownerUserId: string | null;
  /** Who asked for it or assigned it. */
  requester: string | null;
  requesterUserId: string | null;
  /** The deadline as said ("Friday"). */
  due: string | null;
  /** The same deadline as `YYYY-MM-DD`, when it could be worked out. */
  dueDate: string | null;
  atSec: number | null;
  /** The words that state it, as said in the meeting. */
  quote: string | null;
  done: boolean;
  listItemId: string | null;
}

export interface DecisionRecord {
  id: string;
  text: string;
  by: string | null;
  atSec: number | null;
}

const str = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

function asActionItem(record: { _id: string; [key: string]: unknown }): ActionItemRecord {
  return {
    id: record._id,
    meetingId: String(record.meeting ?? ''),
    // Rows written before types existed are plain tasks.
    type: record.type === 'request' || record.type === 'question' ? record.type : 'task',
    task: typeof record.task === 'string' ? record.task : '',
    owner: str(record.owner),
    ownerUserId: str(record.ownerUserId),
    requester: str(record.requester),
    requesterUserId: str(record.requesterUserId),
    due: str(record.due),
    dueDate: str(record.dueDate),
    atSec: typeof record.atSec === 'number' ? record.atSec : null,
    quote: str(record.quote),
    done: record.done === true,
    listItemId: str(record.listItemId),
  };
}

/** A meeting's decisions, in creation (= summary) order. */
export async function listDecisions(app: McpApp, meetingId: string): Promise<DecisionRecord[]> {
  const { records } = await new AppDbClient(app).query({
    collection: 'decisions',
    where: [{ field: 'meeting', op: '==', value: meetingId }],
    limit: 1000,
  });
  return records.map((r) => ({ id: r._id, text: typeof r.text === 'string' ? r.text : '', by: str(r.by), atSec: typeof r.atSec === 'number' ? r.atSec : null }));
}

/** Everyone named on a list of items, requesters and owners alike, in first-seen order — for the "filter by person" chips. */
export function peopleOf(items: readonly ActionItemRecord[]): string[] {
  const seen = new Set<string>();
  for (const item of items) for (const name of [item.requester, item.owner]) if (name) seen.add(name);
  return [...seen];
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
