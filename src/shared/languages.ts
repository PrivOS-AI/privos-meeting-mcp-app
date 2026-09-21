/**
 * Canonical language set for BOTH the UI (interface language) and meetings
 * (spoken language + bilingual-translation target). One source of truth shared
 * by the iframe and the server so the two never drift.
 *
 * `endonym` is the language's own name (shown in every picker); `englishName`
 * is fed to Hub AI prompts ("Output language MUST be: French") and STT/summary
 * providers. Primary-subtag codes only — the app translates a language, not a
 * region.
 */
export const SUPPORTED_LANGUAGES = ['vi', 'en', 'fr', 'zh', 'ko', 'ja', 'de', 'tr'] as const;

export type LanguageCode = (typeof SUPPORTED_LANGUAGES)[number];

export const LANGUAGE_ENDONYMS: Record<LanguageCode, string> = {
  vi: 'Tiếng Việt',
  en: 'English',
  fr: 'Français',
  zh: '中文',
  ko: '한국어',
  ja: '日本語',
  de: 'Deutsch',
  tr: 'Türkçe',
};

export const LANGUAGE_ENGLISH_NAMES: Record<LanguageCode, string> = {
  vi: 'Vietnamese',
  en: 'English',
  fr: 'French',
  zh: 'Chinese',
  ko: 'Korean',
  ja: 'Japanese',
  de: 'German',
  tr: 'Turkish',
};

export function isLanguageCode(value: unknown): value is LanguageCode {
  return typeof value === 'string' && (SUPPORTED_LANGUAGES as readonly string[]).includes(value);
}

/** Coerce any input to a supported code, falling back to `fallback` (default Vietnamese). */
export function asLanguageCode(value: unknown, fallback: LanguageCode = 'vi'): LanguageCode {
  return isLanguageCode(value) ? value : fallback;
}

/**
 * A sensible bilingual-translation target when the user has not picked one, or
 * picked the same language they are speaking: English for any non-English
 * meeting, Vietnamese when the meeting itself is English.
 */
export function defaultTranslationTarget(main: LanguageCode): LanguageCode {
  return main === 'en' ? 'vi' : 'en';
}
