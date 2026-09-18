/**
 * Settings › Caption display (plan.md § Settings item 7). All four fields are
 * local per-user Stage/caption preferences (`local-preferences.ts`) — none of
 * them affect any other workspace member, so none go through
 * `meeting_settings_set`.
 */
import { useState } from 'react';

import { useI18n } from '../../i18n/i18n-provider.js';
import { loadLocalPreferences, saveLocalPreference, type LocalPreferences } from '../../data/local-preferences.js';

const REVEAL_DELAY_MIN_MS = 0;
const REVEAL_DELAY_MAX_MS = 2000;
const REVEAL_DELAY_STEP_MS = 100;

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

      <label className="ma-settings-field">
        <span>{t('settings.captionDisplay.revealDelay', { value: prefs.captionRevealDelayMs })}</span>
        <input
          type="range"
          min={REVEAL_DELAY_MIN_MS}
          max={REVEAL_DELAY_MAX_MS}
          step={REVEAL_DELAY_STEP_MS}
          value={prefs.captionRevealDelayMs}
          onChange={(e) => update('captionRevealDelayMs', Number(e.target.value))}
        />
      </label>
    </section>
  );
}
