import { useI18n } from '../i18n/i18n-provider.js';
import { SpeakerIdentificationPanel } from './settings/speaker-identification-panel.js';

export function SettingsScreen() {
  const { t } = useI18n();
  return (
    <div className="ma-settings-screen">
      <p className="ma-settings-screen__subtitle">{t('screen.settings.subtitle')}</p>
      <SpeakerIdentificationPanel />
    </div>
  );
}
