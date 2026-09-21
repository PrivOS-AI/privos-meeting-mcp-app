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
 */
import { parseToolResult } from '@privos_ai/app-react';
import type { McpApp } from '@privos_ai/app-react';

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

  async query(input: {
    collection: string;
    where?: DbWhereClause[];
    orderBy?: Array<{ field: string; direction: 'asc' | 'desc' }>;
    limit?: number;
    offset?: number;
    populate?: string[];
  }): Promise<{ records: DbRecord[]; total: number }> {
    return callTool(this.app, 'mcpapp.db.query', input);
  }

  async count(input: { collection: string; where?: DbWhereClause[] }): Promise<{ count: number }> {
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
