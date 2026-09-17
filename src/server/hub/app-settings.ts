/**
 * Typed read/write over the global `app_settings` collection (one row per key,
 * value stored as a JSON string in `valueJson`). Runs as the installation bot.
 * Writes to settings are backend-only (workspace-admin tools); reads are used by
 * the provider registry and status tools.
 */
import { AppDbBotClient } from './app-db-bot-client.js';

interface SettingRecord {
  _id: string;
  key: string;
  valueJson: string;
}

function extractRecords(result: unknown): SettingRecord[] {
  const container = result as { items?: unknown; records?: unknown; data?: unknown } | unknown[];
  const arr = Array.isArray(container)
    ? container
    : Array.isArray((container as { items?: unknown }).items)
      ? (container as { items: unknown[] }).items
      : Array.isArray((container as { records?: unknown }).records)
        ? (container as { records: unknown[] }).records
        : Array.isArray((container as { data?: unknown }).data)
          ? (container as { data: unknown[] }).data
          : [];
  return arr.filter((r): r is SettingRecord => Boolean(r) && typeof (r as SettingRecord).key === 'string');
}

/** Read one setting, parsed from JSON, or `undefined` when unset. */
export async function getSetting<T>(db: AppDbBotClient, key: string): Promise<T | undefined> {
  const result = await db.query('app_settings', 'global', {
    where: [{ field: 'key', op: '==', value: key }],
    limit: 1,
  });
  const record = extractRecords(result)[0];
  if (!record) return undefined;
  try {
    return JSON.parse(record.valueJson) as T;
  } catch {
    return undefined;
  }
}

async function findSetting(db: AppDbBotClient, key: string): Promise<SettingRecord | undefined> {
  const result = await db.query('app_settings', 'global', {
    where: [{ field: 'key', op: '==', value: key }],
    limit: 1,
  });
  return extractRecords(result)[0];
}

/**
 * Upsert one setting (create or update by key). If two callers race the create
 * branch the `app_settings.key` unique index rejects the loser; that conflict is
 * caught and retried as an update so the write still lands.
 */
export async function setSetting(db: AppDbBotClient, key: string, value: unknown): Promise<void> {
  const valueJson = JSON.stringify(value);
  const existing = await findSetting(db, key);
  if (existing) {
    await db.update('app_settings', 'global', existing._id, { valueJson });
    return;
  }
  try {
    await db.create('app_settings', 'global', { key, valueJson });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/duplicate|unique|already\s+exists/i.test(message)) throw error;
    const raced = await findSetting(db, key);
    if (!raced) throw error;
    await db.update('app_settings', 'global', raced._id, { valueJson });
  }
}

/**
 * Add a roomId to the `knownRooms` list setting if not already present.
 * NOTE: read-modify-write is not atomic — two bootstraps for DIFFERENT rooms
 * racing could last-write-wins and drop one entry. Acceptable now (bootstrap is
 * rare and idempotent-on-retry); the Phase-3 sweeper must not assume knownRooms
 * is exhaustive on the first call.
 */
export async function appendKnownRoom(db: AppDbBotClient, roomId: string): Promise<string[]> {
  const rooms = (await getSetting<string[]>(db, 'knownRooms')) ?? [];
  if (rooms.includes(roomId)) return rooms;
  const next = [...rooms, roomId];
  await setSetting(db, 'knownRooms', next);
  return next;
}
