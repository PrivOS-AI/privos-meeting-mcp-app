/**
 * Settings › Language & translation (plan.md § Settings item 1). `uiLanguage`
 * is owned by `I18nProvider` (already persists to localStorage); the other
 * three fields are local per-user defaults for the NEXT meeting a user
 * starts (`local-preferences.ts`) — none of these are workspace-wide, so no
 * `meeting_settings_set` call here.
 */
import { useState } from 'react';

import { useI18n, type Language } from '../../i18n/i18n-provider.js';
import { SUPPORTED_LANGUAGES, LANGUAGE_ENDONYMS } from '../../i18n/languages.js';
import { loadLocalPreferences, saveLocalPreference, type LocalPreferences } from '../../data/local-preferences.js';

export function LanguagePanel() {
  const { t, language, setLanguage } = useI18n();
  const [prefs, setPrefs] = useState<LocalPreferences>(loadLocalPreferences);

  function update<K extends keyof LocalPreferences>(key: K, value: LocalPreferences[K]): void {
    setPrefs((prev) => ({ ...prev, [key]: value }));
    saveLocalPreference(key, value);
  }

  return (
    <section className="ma-settings-panel">
      <h3 className="ma-settings-panel__title">{t('settings.language.title')}</h3>

      <label className="ma-settings-field">
        <span>{t('settings.language.uiLanguage')}</span>
        <select value={language} onChange={(e) => setLanguage(e.target.value as Language)}>
          {SUPPORTED_LANGUAGES.map((code) => (
            <option key={code} value={code}>{LANGUAGE_ENDONYMS[code]}</option>
          ))}
        </select>
      </label>

      <label className="ma-settings-field">
        <span>{t('settings.language.meetingLanguage')}</span>
        <select value={prefs.meetingLanguage} onChange={(e) => update('meetingLanguage', e.target.value as LocalPreferences['meetingLanguage'])}>
          {SUPPORTED_LANGUAGES.map((code) => (
            <option key={code} value={code}>{LANGUAGE_ENDONYMS[code]}</option>
          ))}
        </select>
      </label>

      <label className="ma-settings-field ma-settings-field--checkbox">
        <input type="checkbox" checked={prefs.showTranslation} onChange={(e) => update('showTranslation', e.target.checked)} />
        <span>{t('settings.language.showTranslation')}</span>
      </label>

      <label className="ma-settings-field">
        <span>{t('settings.language.translationLang')}</span>
        <select
          value={prefs.translationLang}
          disabled={!prefs.showTranslation}
          onChange={(e) => update('translationLang', e.target.value as LocalPreferences['translationLang'])}
        >
          {SUPPORTED_LANGUAGES.map((code) => (
            <option key={code} value={code}>{LANGUAGE_ENDONYMS[code]}</option>
          ))}
        </select>
      </label>

      <p className="ma-settings-panel__hint">{t('settings.language.hint')}</p>
    </section>
  );
}
