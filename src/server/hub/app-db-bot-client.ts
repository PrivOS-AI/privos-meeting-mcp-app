/**
 * `mcpapp.db.*` wrapper that runs as this app's installation bot (via
 * `callAppPlatformTool`). Every call carries the bound `roomId` when the client
 * has one — for global collections (speaker_profiles, app_settings) too.
 *
 * Why globals also pass the roomId: the Hub grants `db:*` only at the `room`
 * permission context this app declares, and a call resolves to `room` context
 * only when a roomId is present (room-less resolves to `workspace`, which never
 * matches). For a `scope:'global'` collection the Hub IGNORES the roomId for
 * storage — it resolves to the same `app_{appId}_{collection}` and returns the
 * same shared rows (verified in Hub `resolveCollectionName` / `findByApp`) — so
 * passing it only satisfies the permission context, never shards the data.
 * A room-less client (no bound roomId) still sends nothing and is only used
 * where a room genuinely does not exist yet.
 *
 * `ensureAppDbSchema` registers every collection in the shared schema module,
 * treating the Hub's non-idempotent "already registered" as success and
 * reconciling drift with `updateSchema` (validationLevel moderate).
 */
import type { CollectionSchema } from '../../shared/app-db-schema.js';
import { SCHEMAS } from '../../shared/app-db-schema.js';
import { callAppPlatformTool } from './bot-tool-call.js';

/** One App DB row — every collection carries at least `_id`. */
export interface DbRow {
  _id: string;
  [key: string]: unknown;
}

/**
 * Normalize a `mcpapp.db.query` result into a record array. The Hub's shape is
 * not pinned by a shared type on our side, so this accepts every envelope
 * observed in the field (`records`, `items`, `data`, or a bare array) and an
 * optional `total` count. Shared by `AppDbBotClient.getById` and
 * `app-settings.ts` so the tolerant-parsing logic exists exactly once.
 */
export function extractDbRecords(result: unknown): DbRow[] {
  const container = result as { items?: unknown; records?: unknown; data?: unknown } | unknown[];
  const arr = Array.isArray(container)
    ? container
    : Array.isArray((container as { records?: unknown }).records)
      ? (container as { records: unknown[] }).records
      : Array.isArray((container as { items?: unknown }).items)
        ? (container as { items: unknown[] }).items
        : Array.isArray((container as { data?: unknown }).data)
          ? (container as { data: unknown[] }).data
          : [];
  return arr.filter((r): r is DbRow => Boolean(r) && typeof (r as DbRow)._id === 'string');
}

/** Total record count for a query result, falling back to the returned page length. */
export function extractDbTotal(result: unknown): number {
  const total = (result as { total?: unknown } | undefined)?.total;
  return typeof total === 'number' ? total : extractDbRecords(result).length;
}

/** Carries the bound roomId on every call (globals included) so the Hub resolves the granted `room` permission context; see the file header. */
export class AppDbBotClient {
  constructor(private readonly roomId?: string) {}

  /** The bound roomId for BOTH scopes: room scope needs it for storage, global scope needs it only for the permission context. */
  private roomArg(_scope: 'global' | 'room'): string | undefined {
    return this.roomId;
  }

  async registerCollection(schema: CollectionSchema): Promise<unknown> {
    return callAppPlatformTool(
      'mcpapp.db.registerCollection',
      { collection: schema.collection, scope: schema.scope, fields: schema.fields, indexes: schema.indexes },
      'db:schema:write',
      this.roomArg(schema.scope),
    );
  }

  async updateSchema(schema: CollectionSchema): Promise<unknown> {
    return callAppPlatformTool(
      'mcpapp.db.updateSchema',
      { collection: schema.collection, fields: schema.fields },
      'db:schema:write',
      this.roomArg(schema.scope),
    );
  }

  async getSchema(collection: string, scope: 'global' | 'room'): Promise<unknown> {
    return callAppPlatformTool('mcpapp.db.getSchema', { collection }, 'db:schema:read', this.roomArg(scope));
  }

  async listCollections(): Promise<unknown> {
    return callAppPlatformTool('mcpapp.db.listCollections', {}, 'db:schema:read', this.roomId);
  }

  async create(collection: string, scope: 'global' | 'room', data: Record<string, unknown>): Promise<unknown> {
    return callAppPlatformTool('mcpapp.db.create', { collection, data }, 'db:write', this.roomArg(scope));
  }

  async update(collection: string, scope: 'global' | 'room', id: string, data: Record<string, unknown>): Promise<unknown> {
    return callAppPlatformTool('mcpapp.db.update', { collection, id, data }, 'db:write', this.roomArg(scope));
  }

  /** Hard delete — used by `speaker_profile_delete` (P4) to actually erase biometric data, not just unlink it. */
  async delete(collection: string, scope: 'global' | 'room', id: string): Promise<unknown> {
    return callAppPlatformTool('mcpapp.db.delete', { collection, id }, 'db:write', this.roomArg(scope));
  }

  async query(collection: string, scope: 'global' | 'room', args: Record<string, unknown> = {}): Promise<unknown> {
    return callAppPlatformTool('mcpapp.db.query', { collection, ...args }, 'db:read', this.roomArg(scope));
  }

  /**
   * Fetch one row by id via `query` (there is no dedicated `mcpapp.db.get` on
   * the bot-credential surface). Returns `null` when absent instead of
   * throwing, so authz checks can turn a miss into a clear `AppError`.
   */
  async getById(collection: string, scope: 'global' | 'room', id: string): Promise<DbRow | null> {
    const result = await this.query(collection, scope, {
      where: [{ field: '_id', op: '==', value: id }],
      limit: 1,
    });
    return extractDbRecords(result)[0] ?? null;
  }
}

/**
 * Register every schema in the shared module. Idempotent from the caller's view:
 * "already registered/exists" is treated as success, then drift is reconciled.
 * Global collections register with the bound roomId too (for the `room`
 * permission context); the Hub does not persist a roomId on a `scope:'global'`
 * schema (verified in the Hub schema registry — only room scope stamps one), so
 * the global schema stays unstamped and shared across every room.
 */
export async function ensureAppDbSchema(db: AppDbBotClient): Promise<void> {
  for (const schema of SCHEMAS) {
    try {
      await db.registerCollection(schema);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/already\s+(registered|exists)/i.test(message)) throw error;
      await db.updateSchema(schema);
    }
  }
}
