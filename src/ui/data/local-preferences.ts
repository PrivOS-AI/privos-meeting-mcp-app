/**
 * Per-user, local-only Settings preferences (plan.md § Settings: "Cài đặt
 * riêng của người dùng (cỡ chữ Stage, mic ưu tiên) vẫn ở app.storage cục bộ")
 * — anyone can change these, no `meeting_settings_set` admin gate, and they
 * live in `window.localStorage` the same way `i18n-provider.tsx` already
 * persists `uiLanguage` (kept in that provider, not duplicated here). Never
 * written to `app_settings` — these do not affect any other workspace member.
 */
import type { LanguageCode } from '../../shared/languages.js';

export type StageCaptionSize = 'small' | 'medium' | 'large';
export type PrefLanguage = LanguageCode;

export interface LocalPreferences {
  /** Default main language for a NEW meeting (not the running meeting's own language, which is fixed once recording starts). */
  meetingLanguage: PrefLanguage;
  /** Default bilingual-translation target for a new meeting. */
  translationLang: PrefLanguage;
  /** Default "show translation" toggle for a new meeting / Stage caption. */
  showTranslation: boolean;
  stageCaptionSize: StageCaptionSize;
  showLiveSpeakerLabels: boolean;
  /** How long (ms) a non-final caption token is held before it can be shown — smooths jitter from a provider revising a draft token. */
  captionRevealDelayMs: number;
  preferredMicDeviceId: string;
}

export const DEFAULT_LOCAL_PREFERENCES: LocalPreferences = {
  meetingLanguage: 'en',
  translationLang: 'en',
  showTranslation: false,
  stageCaptionSize: 'medium',
  showLiveSpeakerLabels: true,
  captionRevealDelayMs: 400,
  preferredMicDeviceId: '',
};

const STORAGE_PREFIX = 'meeting-agent.pref.';

function readRaw(key: keyof LocalPreferences): string | null {
  try {
    return window.localStorage.getItem(STORAGE_PREFIX + key);
  } catch {
    // Opaque-origin storage can be unavailable — fall back to defaults.
    return null;
  }
}

/** Reads every local preference, falling back to `DEFAULT_LOCAL_PREFERENCES` per-key when unset or unparsable. */
export function loadLocalPreferences(): LocalPreferences {
  const result = { ...DEFAULT_LOCAL_PREFERENCES };
  for (const key of Object.keys(DEFAULT_LOCAL_PREFERENCES) as (keyof LocalPreferences)[]) {
    const raw = readRaw(key);
    if (raw === null) continue;
    try {
      (result as Record<string, unknown>)[key] = JSON.parse(raw);
    } catch {
      // keep the default for this key
    }
  }
  return result;
}

export function saveLocalPreference<K extends keyof LocalPreferences>(key: K, value: LocalPreferences[K]): void {
  try {
    window.localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value));
  } catch {
    // Best-effort — the session still applies the change in memory.
  }
}
