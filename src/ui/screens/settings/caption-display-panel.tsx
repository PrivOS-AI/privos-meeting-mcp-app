/**
 * Settings › Caption display (plan.md § Settings item 7). All fields are local
 * per-user preferences (`local-preferences.ts`) — none of them affect any other
 * workspace member, so none go through `meeting_settings_set`. The recording
 * reads them when it starts: Stage caption size, the default "bilingual" choice
 * on a new meeting, and whether the Stage view shows speaker names.
 */
import { useState } from 'react';

import { useI18n } from '../../i18n/i18n-provider.js';
import { loadLocalPreferences, saveLocalPreference, type LocalPreferences } from '../../data/local-preferences.js';

export function CaptionDisplayPanel() {
  const { t } = useI18n();
  const [prefs, setPrefs] = useState<LocalPreferences>(loadLocalPreferences);

  function update<K extends keyof LocalPreferences>(key: K, value: LocalPreferences[K]): void {
    setPrefs((prev) => ({ ...prev, [key]: value }));
    saveLocalPreference(key, value);
  }

  return (
    <section className="ma-settings-panel">
      <h3 className="ma-settings-panel__title">{t('settings.captionDisplay.title')}</h3>

      <label className="ma-settings-field">
        <span>{t('settings.captionDisplay.stageSize')}</span>
        <select value={prefs.stageCaptionSize} onChange={(e) => update('stageCaptionSize', e.target.value as LocalPreferences['stageCaptionSize'])}>
          <option value="small">{t('settings.captionDisplay.sizeSmall')}</option>
          <option value="medium">{t('settings.captionDisplay.sizeMedium')}</option>
          <option value="large">{t('settings.captionDisplay.sizeLarge')}</option>
        </select>
      </label>

      <label className="ma-settings-field ma-settings-field--checkbox">
        <input type="checkbox" checked={prefs.showTranslation} onChange={(e) => update('showTranslation', e.target.checked)} />
        <span>{t('settings.captionDisplay.showTranslation')}</span>
      </label>

      <label className="ma-settings-field ma-settings-field--checkbox">
        <input type="checkbox" checked={prefs.showLiveSpeakerLabels} onChange={(e) => update('showLiveSpeakerLabels', e.target.checked)} />
        <span>{t('settings.captionDisplay.showLiveSpeakerLabels')}</span>
      </label>
    </section>
  );
}
