/**
 * Read-only wrapper over `app.callServerTool()` for the app-private database
 * (`mcpapp.db.*`). These tools are MCP-only — not reachable via `app.rest()` —
 * so every call goes through the same `callServerTool` path the platform's own
 * tool-calling clients use.
 *
 * Trimmed to display reads only (`query`/`get`/`count`): this Phase 1 scaffold
 * has no screen that writes, and a read-only surface keeps the UI from
 * accidentally depending on write/schema tools before that scope is designed.
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
}
