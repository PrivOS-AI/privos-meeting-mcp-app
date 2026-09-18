/**
 * Idempotent "Meeting action items" Smart List provisioning + item push
 * (phase-06 § Architecture; pattern: `~/projects/genealogy-privos-mcp-app`'s
 * `src/ui/data/list-provisioner.ts` + `hub-rest-client.ts`, trimmed to just
 * the list/field/item surface this app needs — no stages, no relations).
 *
 * Runs entirely over `app.rest()`'s Lists REST surface
 * (`lists.listByRoomId`/`lists.create`/`lists.fields.create`/`lists.info`/
 * `items.create`), gated by the OPTIONAL `lists:read`/`lists:write` scopes.
 * `action-items-card.tsx` hides the "Push to Smart List" button up front when
 * `usePrivosContext().effectiveScopes` lacks `lists:write` (manifest
 * `degradedBehavior`) rather than calling this and surfacing a rejection.
 */
import type { McpApp } from '@privos_ai/app-react';

import { setActionItemListItemId, type ActionItemRecord } from './action-item-read-model.js';

export const ACTION_LIST_NAME = 'Meeting action items';

type FieldKey = 'task' | 'owner' | 'due' | 'meeting' | 'status';

interface FieldDef {
  key: FieldKey;
  name: string;
  type: 'TEXT' | 'DATE' | 'SELECT';
  order: number;
  options?: string[];
}

const FIELDS: readonly FieldDef[] = [
  { key: 'task', name: 'Task', type: 'TEXT', order: 1 },
  { key: 'owner', name: 'Owner', type: 'TEXT', order: 2 },
  { key: 'due', name: 'Due', type: 'DATE', order: 3 },
  { key: 'meeting', name: 'Meeting', type: 'TEXT', order: 4 },
  { key: 'status', name: 'Status', type: 'SELECT', order: 5, options: ['Open', 'Done'] },
];

interface HubFieldDefinition {
  _id: string;
  name: string;
  type: string;
}
interface HubStage {
  _id: string;
  name: string;
}
interface HubList {
  _id: string;
  name: string;
  fieldDefinitions?: HubFieldDefinition[];
}
interface HubEnvelope {
  success?: boolean;
  error?: string;
  message?: string;
  [key: string]: unknown;
}

async function callRest<T>(
  app: McpApp,
  method: 'GET' | 'POST',
  path: string,
  opts?: { query?: Record<string, string | number | boolean>; body?: unknown },
): Promise<T> {
  const res = await app.rest({ method, path, query: opts?.query, body: opts?.body });
  const body = (res?.body ?? res ?? {}) as HubEnvelope;
  const detail = body.error || body.message;
  if (typeof res?.statusCode === 'number' && res.statusCode >= 400) {
    throw new Error(detail || `Hub request failed (${res.statusCode}) for ${method} ${path}`);
  }
  if (body.success === false) throw new Error(detail || `Hub request failed for ${method} ${path}`);
  return body as T;
}

/** Find-or-create the list, returning it together with a stage to file items under — the "Ungroup" stage the Hub seeds on creation, left untouched (same convention as the genealogy app). */
async function resolveList(app: McpApp, roomId: string): Promise<{ list: HubList; stageId: string }> {
  const listed = await callRest<{ lists: HubList[] }>(app, 'GET', 'lists.listByRoomId', {
    query: { roomId, text: ACTION_LIST_NAME, count: 100 },
  });
  const existing = listed.lists.find((l) => l.name === ACTION_LIST_NAME);
  if (existing) {
    const info = await callRest<{ list: HubList; stages: HubStage[] }>(app, 'GET', 'lists.info', { query: { listId: existing._id } });
    return { list: info.list, stageId: info.stages[0]?._id ?? '' };
  }
  const created = await callRest<{ list: HubList; defaultStage: HubStage }>(app, 'POST', 'lists.create', {
    body: { name: ACTION_LIST_NAME, roomId, fieldDefinitions: [] },
  });
  return { list: created.list, stageId: created.defaultStage._id };
}

/** Find-or-create every `FIELDS` entry, matched by name so a manager who edited the list by hand is still recognized (idempotent). */
async function resolveFields(app: McpApp, list: HubList): Promise<Record<FieldKey, string>> {
  const byName = new Map((list.fieldDefinitions ?? []).map((field) => [field.name, field]));
  const map = {} as Record<FieldKey, string>;
  for (const definition of FIELDS) {
    const existing = byName.get(definition.name);
    if (existing) {
      map[definition.key] = existing._id;
      continue;
    }
    const created = await callRest<{ field: HubFieldDefinition }>(app, 'POST', 'lists.fields.create', {
      body: {
        listId: list._id,
        name: definition.name,
        type: definition.type,
        order: definition.order,
        options: definition.options?.map((value) => ({ value })),
      },
    });
    map[definition.key] = created.field._id;
  }
  return map;
}

export interface ProvisionedActionList {
  listId: string;
  stageId: string;
  fieldMap: Record<FieldKey, string>;
}

/** Idempotent find-or-create of the list, its stage and its fields — safe to call before every push. */
export async function provisionActionList(app: McpApp, roomId: string): Promise<ProvisionedActionList> {
  const { list, stageId } = await resolveList(app, roomId);
  const fieldMap = await resolveFields(app, list);
  return { listId: list._id, stageId, fieldMap };
}

/** Pushes every action item that has no `listItemId` yet; items already pushed are skipped — a second call never duplicates. */
export async function pushActionItems(
  app: McpApp,
  roomId: string,
  meetingTitle: string,
  items: readonly ActionItemRecord[],
): Promise<{ pushed: number; skipped: number }> {
  const pending = items.filter((item) => !item.listItemId);
  if (pending.length === 0) return { pushed: 0, skipped: items.length };

  const { listId, stageId, fieldMap } = await provisionActionList(app, roomId);
  let pushed = 0;
  for (const item of pending) {
    const customFields = [
      { fieldId: fieldMap.task, value: item.task },
      ...(item.owner ? [{ fieldId: fieldMap.owner, value: item.owner }] : []),
      ...(item.due ? [{ fieldId: fieldMap.due, value: item.due }] : []),
      { fieldId: fieldMap.meeting, value: meetingTitle },
      { fieldId: fieldMap.status, value: item.done ? 'Done' : 'Open' },
    ];
    const created = await callRest<{ item: { _id: string } }>(app, 'POST', 'items.create', {
      body: { listId, stageId, name: item.task, customFields },
    });
    await setActionItemListItemId(app, item.id, created.item._id);
    pushed += 1;
  }
  return { pushed, skipped: items.length - pending.length };
}
