/**
 * Wrapper over `app.callServerTool()` for the app-private database
 * (`mcpapp.db.*`). These tools are MCP-only — not reachable via `app.rest()` —
 * so every call goes through the same `callServerTool` path the platform's own
 * tool-calling clients use.
 *
 * Phase 1 shipped reads only (`query`/`get`/`count`). Phase 2 adds
 * `create`/`update`, scoped to exactly the iframe-owned fields documented in
 * plan.md's field-ownership table (e.g. `meetings.status:'recording'`,
 * `partCount`, `bookmarks`) — see `meeting-draft-repository.ts`, the only
 * caller of the write methods.
 *
 * Phase 7 adds `delete` (user-owned rows only — `meeting-read-model.ts`'s
 * `deleteMeeting`, gated client-side to `ownerUserId`) and `aggregate`
 * (`meeting-stats.ts`'s `sum(durationSec)` — avoids paging every record just
 * to total a number). Both mirror `mcpapp.db.*` tools documented in
 * `privos-dev-docs/mcp-app-platform/apis/tools-database.md` and already used
 * server-side by `AppDbBotClient` (`delete`) — same tool names, user context.
 *
 * `queryAll` / `queryPage` use the Hub's opt-in paging (`paginate: true`,
 * `shared/list-pages.ts`) and still read the old `{ records, total }` answer
 * of a Hub without it; `query` stays one plain answer for bounded lookups.
 */
import { parseToolResult } from '@privos_ai/app-react';
import type { McpApp } from '@privos_ai/app-react';

import { pagedBody, readAllPages } from '../../shared/list-pages.js';

export interface DbRecord {
  _id: string;
  _createdAt: string;
  _updatedAt: string;
  [key: string]: unknown;
}

export interface DbWhereClause {
  field: string;
  op: '==' | '!=' | '>' | '<' | '>=' | '<=' | 'in' | 'not-in' | 'array-contains' | 'array-contains-any';
  value: unknown;
}

export interface DbQueryInput {
  collection: string;
  where?: DbWhereClause[];
  orderBy?: Array<{ field: string; direction: 'asc' | 'desc' }>;
  limit?: number;
  offset?: number;
  populate?: string[];
}

/** One page of `queryPage`. */
export interface DbQueryPage {
  records: DbRecord[];
  /** Matching rows, `null` when the Hub did not count them; with `totalCapped` the Hub stopped counting (10,000) and the real number is higher. */
  total: number | null;
  totalCapped: boolean;
  /** Exact on a paging Hub; on an older one, `offset + records < total` (a capped total: a full page). */
  hasMore: boolean;
}

/** `mcpapp.db.query`'s own maximum on a Hub without paging. */
const LEGACY_QUERY_LIMIT = 1000;

/** The rows of an old-Hub `{ records }` answer, or a page's bare `items` (`readAllPages`); `null` (no envelope) reads as none. */
function recordsOf(body: unknown): DbRecord[] {
  if (Array.isArray(body)) return body as DbRecord[];
  return (body as { records?: DbRecord[] } | null)?.records ?? [];
}

async function callTool<T>(app: McpApp, name: string, args: Record<string, unknown>): Promise<T> {
  // `callServerTool` resolves with the raw MCP tool-result envelope
  // (`{ content: [{ text }] }`), not the payload — `parseToolResult` unwraps
  // the JSON and rethrows the Hub's message on an error result. A null result
  // (e.g. `get` of a missing id) carries no envelope, so it passes straight
  // through.
  const raw = await app.callServerTool({ name, arguments: args });
  return (raw == null ? raw : parseToolResult(raw)) as T;
}

export class AppDbClient {
  constructor(private readonly app: McpApp) {}

  async get(collection: string, id: string): Promise<DbRecord | null> {
    return callTool(this.app, 'mcpapp.db.get', { collection, id });
  }

  /** One plain answer — for lookups that read a bounded page (`limit: 1`, "latest N"). */
  async query(input: DbQueryInput): Promise<{ records: DbRecord[]; total: number }> {
    return callTool(this.app, 'mcpapp.db.query', { ...input });
  }

  /** Every matching row, page by page. A Hub without paging answers once with up to `limit` rows (default 1000, its old cap), as `query` did. */
  async queryAll(input: Omit<DbQueryInput, 'offset'>): Promise<DbRecord[]> {
    const { limit = LEGACY_QUERY_LIMIT, ...rest } = input;
    return readAllPages((paging) => callTool(this.app, 'mcpapp.db.query', { ...rest, ...paging }), recordsOf, limit);
  }

  /** One page for a table: `hasMore` drives "Load more", never `total` (it can be `null` or capped). */
  async queryPage(input: DbQueryInput & { limit: number }): Promise<DbQueryPage> {
    const offset = input.offset ?? 0;
    const body = await callTool<unknown>(this.app, 'mcpapp.db.query', { ...input, offset, paginate: true });
    const page = pagedBody(body);
    if (page) {
      const { total, totalCapped, hasMore } = page.pagination;
      return { records: page.items as DbRecord[], total: typeof total === 'number' ? total : null, totalCapped: totalCapped === true, hasMore };
    }
    // Older Hub: `{ records, total, totalCapped }`, as before.
    const old = body as { total?: unknown; totalCapped?: unknown } | null;
    const records = recordsOf(body);
    const total = typeof old?.total === 'number' ? old.total : null;
    const totalCapped = old?.totalCapped === true;
    const hasMore = totalCapped || total === null ? records.length === input.limit : offset + records.length < total;
    return { records, total, totalCapped, hasMore };
  }

  /** `capped`: the Hub stopped counting at its cap — `count` is a lower bound, not the number. */
  async count(input: { collection: string; where?: DbWhereClause[] }): Promise<{ count: number; capped?: boolean }> {
    return callTool(this.app, 'mcpapp.db.count', input);
  }

  async create(collection: string, data: Record<string, unknown>): Promise<DbRecord> {
    return callTool(this.app, 'mcpapp.db.create', { collection, data });
  }

  async update(collection: string, id: string, data: Record<string, unknown>): Promise<void> {
    await callTool(this.app, 'mcpapp.db.update', { collection, id, data });
  }

  async delete(collection: string, id: string): Promise<void> {
    await callTool(this.app, 'mcpapp.db.delete', { collection, id });
  }

  /** `op:'count'|'sum'|'avg'|'min'|'max'`; `result` is a single number, or `{_id, result}[]` when `groupBy` is given. */
  async aggregate(input: {
    collection: string;
    op: 'count' | 'sum' | 'avg' | 'min' | 'max';
    field?: string;
    where?: DbWhereClause[];
    groupBy?: string;
  }): Promise<{ result: number | Array<{ _id: unknown; result: number }> }> {
    return callTool(this.app, 'mcpapp.db.aggregate', input);
  }
}
