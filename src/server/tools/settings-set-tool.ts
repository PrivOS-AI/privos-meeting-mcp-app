/**
 * `meeting_settings_set {key, value}` — the single backend write path into
 * global `app_settings` (QĐ-14: workspace-admin only, since these keys affect
 * the whole workspace, not just the calling user's room). The allowlist,
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
  title: 'Cập nhật cấu hình workspace',
  description: 'Ghi một cấu hình toàn workspace (nhà cung cấp STT, ngưỡng nhận diện người nói, lưu trữ…) — chỉ quản trị viên workspace.',
  inputSchema: {
    type: 'object',
    required: ['key', 'value'],
    properties: {
      key: { type: 'string' },
      value: {},
    },
  },
  async execute(args, context) {
    const actor = requireVerifiedActor(context);
    if (!canManageRoomSettings(actor)) {
      throw new AppError('Chỉ thành viên của phòng mới thay đổi được cấu hình của phòng này.');
    }

    const key = typeof args.key === 'string' ? args.key.trim() : '';
    if (!isWorkspaceSettingKey(key)) {
      throw new AppError(`Cấu hình "${key}" không được hỗ trợ.`);
    }
    const value = WORKSPACE_SETTING_VALIDATORS[key](args.value);

    // Settings are per room: bind to the caller's verified room (also the granted `room` permission context).
    const db = new AppDbBotClient(actor.roomId);
    await setSetting(db, key, value);
    return { settings: { [key]: value } };
  },
};
