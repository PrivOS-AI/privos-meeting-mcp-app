/**
 * The set of languages the UI ships. Kept apart from the provider so the
 * language-resolution logic can be imported (and unit-tested) without pulling
 * in React or the translation bundles.
 */
export const SUPPORTED_LANGUAGES = ['vi', 'en'] as const;

export type Language = (typeof SUPPORTED_LANGUAGES)[number];
