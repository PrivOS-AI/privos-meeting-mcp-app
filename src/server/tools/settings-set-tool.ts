/**
 * `meeting_settings_set {key, value}` — the single backend write path into
 * global `app_settings` (QĐ-14: workspace-admin only, since these keys affect
 * the whole workspace, not just the calling user's room). Ships now (ahead of
 * the dedicated settings phase's full `src/shared/app-settings.ts` +
 * `settings-store.ts` refactor) specifically to unblock two callers that
 * already reference this exact tool name/shape:
 *  - `src/ui/screens/settings/speaker-identification-panel.tsx` (P4's match-
 *    threshold slider, written against this tool from day one).
 *  - the later settings/hardening phase's provider selects and retention
 *    inputs (plan.md's tool table already reserves this name for them).
 *
 * The key allowlist below is intentionally the exact set plan.md documents
 * for `app_settings` today; a later phase MAY extend it (e.g. `knownRooms`
 * stays internal/bootstrap-only and is deliberately NOT in this allowlist —
 * only admin-tunable operational settings belong here).
 */
import { AppError } from '../../shared/app-error.js';
import { AppDbBotClient } from '../hub/app-db-bot-client.js';
import { setSetting } from '../hub/app-settings.js';
import { isWorkspaceAdmin, requireVerifiedActor } from './authz.js';
import type { AppTool } from './registry.js';

type Validator = (value: unknown) => unknown;

function enumValidator(name: string, allowed: readonly string[]): Validator {
  return (value) => {
    if (typeof value !== 'string' || !allowed.includes(value)) {
      throw new AppError(`${name} phải là một trong: ${allowed.join(', ')}.`);
    }
    return value;
  };
}

function unitFractionValidator(name: string): Validator {
  return (value) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value >= 1) {
      throw new AppError(`${name} phải là số trong khoảng (0, 1).`);
    }
    return value;
  };
}

function nonNegativeIntValidator(name: string): Validator {
  return (value) => {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      throw new AppError(`${name} phải là số nguyên không âm.`);
    }
    return value;
  };
}

function booleanValidator(name: string): Validator {
  return (value) => {
    if (typeof value !== 'boolean') throw new AppError(`${name} phải là true/false.`);
    return value;
  };
}

/** Every workspace-admin-tunable `app_settings` key this tool accepts, per plan.md's `app_settings` row. */
const SETTINGS_VALIDATORS: Record<string, Validator> = {
  sttRealtimeProvider: enumValidator('sttRealtimeProvider', ['soniox', 'elevenlabs']),
  sttAsyncProvider: enumValidator('sttAsyncProvider', ['soniox', 'elevenlabs']),
  speakerMatchThreshold: unitFractionValidator('speakerMatchThreshold'),
  speakerSessionMatchThreshold: unitFractionValidator('speakerSessionMatchThreshold'),
  speakerSessionMergeThreshold: unitFractionValidator('speakerSessionMergeThreshold'),
  summaryLength: enumValidator('summaryLength', ['short', 'normal', 'detailed']),
  summaryLanguage: enumValidator('summaryLanguage', ['vi', 'en']),
  autoDeleteAudioDays: nonNegativeIntValidator('autoDeleteAudioDays'),
  interruptedPartsRetentionDays: nonNegativeIntValidator('interruptedPartsRetentionDays'),
  keepOriginalAudio: booleanValidator('keepOriginalAudio'),
};

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
    if (!isWorkspaceAdmin(actor)) {
      throw new AppError('Chỉ quản trị viên workspace mới thay đổi được cấu hình này.');
    }

    const key = typeof args.key === 'string' ? args.key.trim() : '';
    const validator = SETTINGS_VALIDATORS[key];
    if (!validator) {
      throw new AppError(`Cấu hình "${key}" không được hỗ trợ.`);
    }
    const value = validator(args.value);

    const db = new AppDbBotClient();
    await setSetting(db, key, value);
    return { settings: { [key]: value } };
  },
};
