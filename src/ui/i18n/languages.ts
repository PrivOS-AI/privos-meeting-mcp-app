/**
 * UI-facing re-export of the canonical language set (`src/shared/languages.ts`),
 * kept as its own module so `resolve-language.ts` can be imported and unit-tested
 * without pulling in React or the translation bundles. `Language` is the UI's
 * name for a language code.
 */
export { SUPPORTED_LANGUAGES, LANGUAGE_ENDONYMS, type LanguageCode as Language } from '../../shared/languages.js';
