/**
 * Minimal key-based i18n.
 *
 * Vietnamese is the default and English ships alongside it from the MVP.
 * Unlike the sibling genealogy app, this app is small enough that its copy
 * lives in one bundle per language rather than split per feature area.
 *
 * The Hub host context does not expose the user's locale (see the
 * `PrivosContext` shape in @privos_ai/app-react), so the opening language is
 * resolved in-app: the user's last choice, else the browser's preference, else
 * Vietnamese (see `resolve-language.ts`).
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { type Language } from './languages.js';
import { readBrowserLanguages, resolveInitialLanguage } from './resolve-language.js';

import en from './en.json';
import vi from './vi.json';
import fr from './fr.json';
import zh from './zh.json';
import ko from './ko.json';
import ja from './ja.json';
import de from './de.json';
import tr from './tr.json';

export { SUPPORTED_LANGUAGES, type Language } from './languages.js';

const bundles: Record<Language, Record<string, string>> = { vi, en, fr, zh, ko, ja, de, tr };

const STORAGE_KEY = 'meeting-agent.language';

interface I18nValue {
  language: Language;
  setLanguage(language: Language): void;
  /** Translate a key; `{name}` style placeholders are filled from `vars`. */
  t(key: string, vars?: Record<string, string | number>): string;
}

const I18nContext = createContext<I18nValue | null>(null);

function readStoredLanguage(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    // The app document runs in an opaque origin; storage can be unavailable.
    return null;
  }
}

function openingLanguage(): Language {
  return resolveInitialLanguage({ stored: readStoredLanguage(), browserLanguages: readBrowserLanguages() });
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Language>(openingLanguage);

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  const setLanguage = useCallback((next: Language) => {
    setLanguageState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Persisting the choice is best-effort; the session still switches.
    }
  }, []);

  const t = useCallback(
    (key: string, vars?: Record<string, string | number>) => {
      // Fall back through Vietnamese to the key itself, so a missing English
      // string shows real content instead of a blank in the UI.
      const template = bundles[language][key] ?? bundles.en[key] ?? key;
      if (!vars) return template;
      return template.replace(/\{(\w+)\}/g, (match, name: string) =>
        name in vars ? String(vars[name]) : match,
      );
    },
    [language],
  );

  const value = useMemo<I18nValue>(() => ({ language, setLanguage, t }), [language, setLanguage, t]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error('useI18n must be used inside an I18nProvider.');
  return value;
}

/** Shorthand for components that only need the translate function. */
export function useTranslate(): I18nValue['t'] {
  return useI18n().t;
}
