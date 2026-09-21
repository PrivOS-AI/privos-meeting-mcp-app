/**
 * Which language the app opens in.
 *
 * Precedence, highest first:
 *   1. the language the user last picked in the app
 *   2. the browser's preferred languages
 *   3. Vietnamese
 *
 * An explicit choice has to outrank the browser: a Vietnamese speaker on an
 * English-locale machine picks "Tiếng Việt" once, and having the browser win on
 * the next load would silently undo it every time.
 *
 * Matching is by primary subtag, so `en-GB`, `en-US` and `en` all resolve to
 * English — the app translates a language, not a region.
 */
import { SUPPORTED_LANGUAGES, type Language } from './languages.js';

export const DEFAULT_LANGUAGE: Language = 'vi';

function isSupported(value: string | null | undefined): value is Language {
  return Boolean(value) && (SUPPORTED_LANGUAGES as readonly string[]).includes(value as string);
}

/** First browser preference the app can actually render. */
export function matchBrowserLanguage(browserLanguages: readonly string[]): Language | null {
  for (const tag of browserLanguages) {
    const primary = tag.split('-')[0]?.toLowerCase();
    if (isSupported(primary)) return primary;
  }
  return null;
}

export function resolveInitialLanguage(input: {
  stored?: string | null;
  browserLanguages?: readonly string[];
}): Language {
  if (isSupported(input.stored)) return input.stored;
  return matchBrowserLanguage(input.browserLanguages ?? []) ?? DEFAULT_LANGUAGE;
}

/** The browser's preference list, most preferred first. */
export function readBrowserLanguages(): readonly string[] {
  if (typeof navigator === 'undefined') return [];
  // `navigator.languages` is the ordered list; `language` is the single top
  // preference and the only one older WebViews expose.
  return navigator.languages?.length ? navigator.languages : [navigator.language].filter(Boolean);
}
