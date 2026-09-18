/**
 * `mcpapp.db.*` wrapper that runs as this app's installation bot (via
 * `callAppPlatformTool`). Global collections (speaker_profiles, app_settings)
 * are addressed room-lessly; room collections pass the bound `roomId`.
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

/** Room-less scopes never send a roomId; room scopes require the bound one. */
export class AppDbBotClient {
  constructor(private readonly roomId?: string) {}

  private roomArg(scope: 'global' | 'room'): string | undefined {
    return scope === 'room' ? this.roomId : undefined;
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
 * Global collections register room-lessly (verified QĐ-05); a global schema that
 * comes back stamped with a roomId is the poisoned state P1 spike 4 checks for.
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
