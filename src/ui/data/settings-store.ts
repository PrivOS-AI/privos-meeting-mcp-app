/**
 * Iframe-side read/write for the WORKSPACE-WIDE settings in `app_settings`
 * (QĐ-14). Reads go straight to the App DB (any verified user may read
 * `app_settings` — `db:read` is a required permission for every member);
 * writes always go through `meeting_settings_set` (admin-only, validated
 * server-side) — this module never writes `app_settings` directly. Shape,
 * defaults and the exact key allowlist live in `src/shared/app-settings.ts`,
 * the same module the backend tool validates against (DRY).
 */
import { parseToolResult } from '@privos_ai/app-react';
import type { McpApp } from '@privos_ai/app-react';

import {
  DEFAULT_WORKSPACE_SETTINGS,
  isWorkspaceSettingKey,
  WORKSPACE_SETTING_KEYS,
  type WorkspaceAppSettings,
} from '../../shared/app-settings.js';
import { AppDbClient } from './app-db-client.js';

/** DEFAULTS merged with whatever rows exist in `app_settings` — an unset key silently keeps its default. */
export async function loadWorkspaceSettings(app: McpApp): Promise<WorkspaceAppSettings> {
  const db = new AppDbClient(app);
  const { records } = await db.query({ collection: 'app_settings', limit: 200 });
  const settings: WorkspaceAppSettings = { ...DEFAULT_WORKSPACE_SETTINGS };
  for (const row of records) {
    const key = typeof row.key === 'string' ? row.key : '';
    if (!isWorkspaceSettingKey(key)) continue;
    try {
      (settings as unknown as Record<string, unknown>)[key] = JSON.parse(String(row.valueJson));
    } catch {
      // keep the default for this key
    }
  }
  return settings;
}

/** `WORKSPACE_SETTING_KEYS` re-exported so panels can iterate without importing the shared module twice. */
export { WORKSPACE_SETTING_KEYS };

/** Admin-only write — `meeting_settings_set` re-validates and rejects a non-admin caller server-side regardless. */
export async function saveWorkspaceSetting<K extends keyof WorkspaceAppSettings>(
  app: McpApp,
  key: K,
  value: WorkspaceAppSettings[K],
): Promise<void> {
  const raw = await app.callServerTool({ name: 'meeting_settings_set', arguments: { key, value } });
  parseToolResult(raw);
}
