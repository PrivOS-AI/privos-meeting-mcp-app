/**
 * Settings shell: 240px nav + 7 panels (plan.md § Settings, design nav 1e).
 * Each panel owns its own data loading/saving — this component is pure
 * navigation state.
 */
import { useState } from 'react';

import { useI18n } from '../i18n/i18n-provider.js';
import { AiSummaryPanel } from './settings/ai-summary-panel.js';
import { CaptionDisplayPanel } from './settings/caption-display-panel.js';
import { LanguagePanel } from './settings/language-panel.js';
import { MicrophonePanel } from './settings/microphone-panel.js';
import { PrivacyPanel } from './settings/privacy-panel.js';
import { SpeakerIdentificationPanel } from './settings/speaker-identification-panel.js';
import { SpeechRecognitionPanel } from './settings/speech-recognition-panel.js';

type SettingsSection = 'language' | 'speech' | 'microphone' | 'speaker' | 'summary' | 'privacy' | 'caption';

const SECTIONS: readonly SettingsSection[] = ['language', 'speech', 'microphone', 'speaker', 'summary', 'privacy', 'caption'];

export function SettingsScreen() {
  const { t } = useI18n();
  const [section, setSection] = useState<SettingsSection>('language');

  return (
    <div className="ma-settings-screen ma-settings-screen--with-nav">
      <nav className="ma-settings-nav" aria-label={t('screen.settings.title')}>
        {SECTIONS.map((key) => (
          <button
            key={key}
            type="button"
            className={key === section ? 'ma-settings-nav__item ma-settings-nav__item--active' : 'ma-settings-nav__item'}
            onClick={() => setSection(key)}
          >
            {t(`settings.nav.${key}`)}
          </button>
        ))}
      </nav>
      <div className="ma-settings-content">
        <p className="ma-settings-screen__subtitle">{t('screen.settings.subtitle')}</p>
        {section === 'language' ? <LanguagePanel /> : null}
        {section === 'speech' ? <SpeechRecognitionPanel /> : null}
        {section === 'microphone' ? <MicrophonePanel /> : null}
        {section === 'speaker' ? <SpeakerIdentificationPanel /> : null}
        {section === 'summary' ? <AiSummaryPanel /> : null}
        {section === 'privacy' ? <PrivacyPanel /> : null}
        {section === 'caption' ? <CaptionDisplayPanel /> : null}
      </div>
    </div>
  );
}
