/**
 * `meeting_settings_set {key, value}` — the single backend write path into
 * `app_settings`, keyed per room. Only the room's owners and moderators, and
 * workspace admins, may write (`can-manage-room-settings.ts`, fail closed
 * without the signed role claims). The allowlist,
 * defaults and validators live in `src/shared/app-settings.ts` — the same
 * module the iframe's `settings-store.ts` reads for its DEFAULTS, so the two
 * sides of the Settings screen cannot drift (DRY, plan.md § Settings store).
 */
import { AppError } from '../../shared/app-error.js';
import { isWorkspaceSettingKey, WORKSPACE_SETTING_VALIDATORS } from '../../shared/app-settings.js';
import { AppDbBotClient } from '../hub/app-db-bot-client.js';
import { setSetting } from '../hub/app-settings.js';
import { requireVerifiedActor } from './authz.js';
import { canManageRoomSettings } from './can-manage-room-settings.js';
import type { AppTool } from './registry.js';

export const settingsSetTool: AppTool = {
  name: 'meeting_settings_set',
  title: 'Update room settings',
  description: "Write a setting for the caller's room (STT provider, speaker-match thresholds, retention…) — room owners, moderators and workspace admins only.",
  inputSchema: {
    type: 'object',
    required: ['key', 'value'],
    properties: {
      key: { type: 'string', maxLength: 64 },
      value: { type: ['string', 'number', 'boolean'], maxLength: 64 },
    },
  },
  async execute(args, context) {
    const actor = requireVerifiedActor(context);
    if (!canManageRoomSettings(actor)) {
      throw new AppError('Only room owners, moderators and workspace admins can change these settings.', 'FORBIDDEN');
    }

    const key = typeof args.key === 'string' ? args.key.trim() : '';
    if (!isWorkspaceSettingKey(key)) {
      throw new AppError(`Setting "${key}" is not supported.`, 'INVALID_INPUT');
    }
    const value = WORKSPACE_SETTING_VALIDATORS[key](args.value);

    // Settings are per room: bind to the caller's verified room (also the granted `room` permission context).
    const db = new AppDbBotClient(actor.roomId);
    await setSetting(db, key, value);
    return { settings: { [key]: value } };
  },
};
