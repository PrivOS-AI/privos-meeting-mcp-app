/**
 * Single source of truth for the workspace-wide `app_settings` keys this app
 * persists (QĐ-14): shape, defaults, and validators shared by the backend
 * write path (`src/server/tools/settings-set-tool.ts`) and the iframe read
 * path (`src/ui/data/settings-store.ts`) — one allowlist, not two that can
 * drift. Per-user preferences (Stage caption size, preferred mic, live
 * caption reveal delay, per-meeting language defaults) are documented
 * separately in `src/ui/data/local-preferences.ts` — plan.md § Settings is
 * explicit that those stay in local storage, never `app_settings`, so they
 * never need a workspace-admin gate.
 */
import { AppError } from './app-error.js';

export type SttVendor = 'soniox' | 'elevenlabs';
export type SummaryLength = 'short' | 'normal' | 'detailed';
export type SettingsLanguage = 'vi' | 'en';

/** Every key `meeting_settings_set` accepts, exactly plan.md's `app_settings` row (minus `knownRooms`, which is bootstrap-internal, never admin-tunable). */
export interface WorkspaceAppSettings {
  sttRealtimeProvider: SttVendor;
  sttAsyncProvider: SttVendor;
  speakerMatchThreshold: number;
  speakerSessionMatchThreshold: number;
  speakerSessionMergeThreshold: number;
  summaryLength: SummaryLength;
  summaryLanguage: SettingsLanguage;
  keepOriginalAudio: boolean;
  autoDeleteAudioDays: number;
  interruptedPartsRetentionDays: number;
}

export const DEFAULT_WORKSPACE_SETTINGS: WorkspaceAppSettings = {
  sttRealtimeProvider: 'soniox',
  sttAsyncProvider: 'soniox',
  speakerMatchThreshold: 0.5,
  speakerSessionMatchThreshold: 0.4,
  speakerSessionMergeThreshold: 0.6,
  summaryLength: 'normal',
  summaryLanguage: 'vi',
  keepOriginalAudio: false,
  autoDeleteAudioDays: 90,
  interruptedPartsRetentionDays: 7,
};

export const WORKSPACE_SETTING_KEYS = Object.keys(DEFAULT_WORKSPACE_SETTINGS) as ReadonlyArray<keyof WorkspaceAppSettings>;

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

/** One validator per `WorkspaceAppSettings` key — the exact allowlist `meeting_settings_set` enforces. */
export const WORKSPACE_SETTING_VALIDATORS: Record<keyof WorkspaceAppSettings, Validator> = {
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

export function isWorkspaceSettingKey(key: string): key is keyof WorkspaceAppSettings {
  return (WORKSPACE_SETTING_KEYS as readonly string[]).includes(key);
}
