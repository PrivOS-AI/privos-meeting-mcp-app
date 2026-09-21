/**
 * Typed read/write over the `app_settings` collection (one row per key, value
 * stored as a JSON string in `valueJson`). Runs as the installation bot.
 *
 * Settings are PER ROOM: the collection itself is `scope:'global'` (shared rows),
 * so every key is namespaced with the room the client is bound to
 * (`roomSettingKey`). A room-less client falls back to the bare key, which no
 * room ever reads — callers bind a room.
 */
import { roomSettingKey } from '../../shared/app-settings.js';
import { extractDbRecords, type AppDbBotClient, type DbRow } from './app-db-bot-client.js';

function storageKey(db: AppDbBotClient, key: string): string {
  return db.boundRoomId ? roomSettingKey(db.boundRoomId, key) : key;
}

interface SettingRecord extends DbRow {
  key: string;
  valueJson: string;
}

function extractRecords(result: unknown): SettingRecord[] {
  return extractDbRecords(result).filter((r): r is SettingRecord => typeof r.key === 'string');
}

/** Read one setting, parsed from JSON, or `undefined` when unset. */
export async function getSetting<T>(db: AppDbBotClient, key: string): Promise<T | undefined> {
  const result = await db.query('app_settings', 'global', {
    where: [{ field: 'key', op: '==', value: storageKey(db, key) }],
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
    where: [{ field: 'key', op: '==', value: storageKey(db, key) }],
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
    await db.create('app_settings', 'global', { key: storageKey(db, key), valueJson });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/duplicate|unique|already\s+exists/i.test(message)) throw error;
    const raced = await findSetting(db, key);
    if (!raced) throw error;
    await db.update('app_settings', 'global', raced._id, { valueJson });
  }
}
