/**
 * A minimal in-memory stand-in for `RoomBoundHubClient.authorizedFetch`, shared
 * by tool tests that go through `AppDbBotClient` (`mcp-apps.tool-call` →
 * `mcpapp.db.*`) and/or `hub-ai-client.ts` (`agents.sandbox.generate`). Not a
 * faithful Hub — just enough query/create/update + where-clause matching to
 * exercise this app's own authz and validation logic without a live Hub.
 */
import { vi } from 'vitest';
import type { RoomBoundHubClient, RoomBoundHubFetchInit } from '@privos_ai/app-server';

export type Row = Record<string, unknown> & { _id: string };
export type Store = Record<string, Row[]>;

interface WhereClause {
  field: string;
  op: string;
  value: unknown;
}

interface FakeHubOptions {
  store: Store;
  /** Override/extend behavior for a specific REST path (e.g. sandbox generate) or toolName. */
  handlers?: Record<string, (body: Record<string, unknown>) => unknown>;
}

function compare(actual: unknown, op: string, expected: unknown): boolean {
  switch (op) {
    case '==':
      return actual === expected;
    case '!=':
      return actual !== expected;
    case '>=':
      return String(actual ?? '') >= String(expected ?? '');
    case '<=':
      return String(actual ?? '') <= String(expected ?? '');
    case '>':
      return String(actual ?? '') > String(expected ?? '');
    case '<':
      return String(actual ?? '') < String(expected ?? '');
    default:
      return true;
  }
}

function matches(row: Row, where: WhereClause[] = []): boolean {
  return where.every((clause) => compare(row[clause.field], clause.op, clause.value));
}

export function installFakeHub(options: FakeHubOptions): RoomBoundHubClient & { store: Store } {
  const { store, handlers = {} } = options;
  let seq = 0;

  function handleDbToolCall(toolName: string, args: Record<string, unknown>): unknown {
    if (toolName === 'mcpapp.db.query') {
      const { collection, where, limit } = args as { collection: string; where?: WhereClause[]; limit?: number };
      const rows = (store[collection] ?? []).filter((row) => matches(row, where));
      const page = typeof limit === 'number' ? rows.slice(0, limit) : rows;
      return { records: page, total: rows.length };
    }
    if (toolName === 'mcpapp.db.get') {
      const { collection, id } = args as { collection: string; id: string };
      const row = (store[collection] ?? []).find((r) => r._id === id);
      if (!row) throw new Error(`Record "${id}" not found`); // mirrors the Hub miss that getById turns into null
      return row;
    }
    if (toolName === 'mcpapp.db.create') {
      const { collection, data } = args as { collection: string; data: Record<string, unknown> };
      const row: Row = { _id: `row-${++seq}`, ...data };
      store[collection] = [...(store[collection] ?? []), row];
      return row;
    }
    if (toolName === 'mcpapp.db.update') {
      const { collection, id, data } = args as { collection: string; id: string; data: Record<string, unknown> };
      store[collection] = (store[collection] ?? []).map((row) => (row._id === id ? { ...row, ...data } : row));
      return { updated: true };
    }
    if (toolName === 'mcpapp.db.delete') {
      const { collection, id } = args as { collection: string; id: string };
      store[collection] = (store[collection] ?? []).filter((row) => row._id !== id);
      return { deleted: true };
    }
    throw new Error(`fake hub: unhandled toolName "${toolName}"`);
  }

  const authorizedFetch = vi.fn(async (path: string, init: RoomBoundHubFetchInit): Promise<Response> => {
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (path === '/api/v1/mcp-apps.tool-call') {
      const toolName = String(body.toolName);
      const result = handlers[toolName]
        ? handlers[toolName]((body.arguments ?? {}) as Record<string, unknown>)
        : handleDbToolCall(toolName, (body.arguments ?? {}) as Record<string, unknown>);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ success: true, content: [{ type: 'text', text: JSON.stringify(result) }] }),
      } as Response;
    }
    if (handlers[path]) {
      const result = handlers[path](body);
      return { ok: true, status: 200, text: async () => JSON.stringify(result) } as Response;
    }
    throw new Error(`fake hub: unhandled path "${path}"`);
  });

  return { authorizedFetch, store };
}
