/**
 * "Bắt đầu ghi" form: title, primary language, read-only room + active STT
 * provider name, start button. `getUserMedia` runs inside this button's own
 * click handler (both for the mic permission gesture requirement AND the
 * Screen Wake Lock gesture requirement).
 */
import { useEffect, useState } from 'react';
import { parseToolResult, usePrivosApp, usePrivosContext } from '@privos_ai/app-react';

import { useI18n } from '../i18n/i18n-provider.js';
import { SUPPORTED_LANGUAGES, LANGUAGE_ENDONYMS, type Language } from '../i18n/languages.js';
import { defaultTranslationTarget } from '../../shared/languages.js';
import { loadLocalPreferences } from '../data/local-preferences.js';
import { useRecordingStore } from '../stores/recording-store.js';
import { Icon } from '../components/icon.js';

export interface NewMeetingScreenProps {
  onStarted(): void;
}

export function NewMeetingScreen({ onStarted }: NewMeetingScreenProps) {
  const { t } = useI18n();
  const app = usePrivosApp();
  const context = usePrivosContext();
  const store = useRecordingStore();

  const prefs = loadLocalPreferences();
  const [title, setTitle] = useState('');
  const [language, setLanguage] = useState<Language>(prefs.meetingLanguage);
  const [translationLang, setTranslationLang] = useState<Language>(prefs.translationLang);
  // Bilingual captions add latency + Hub-AI cost, so start unchecked; the user opts in per meeting.
  const [translationEnabled, setTranslationEnabled] = useState(false);
  const [provider, setProvider] = useState<string | null>(null);
  const [micError, setMicError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    app
      .callServerTool({ name: 'meeting_stt_status', arguments: {} })
      .then((raw) => {
        if (cancelled) return;
        const parsed = parseToolResult(raw) as { activeRealtimeProvider?: string };
        setProvider(parsed?.activeRealtimeProvider ?? null);
      })
      .catch(() => {
        if (!cancelled) setProvider(null);
      });
    return () => {
      cancelled = true;
    };
  }, [app]);

  async function handleStart(): Promise<void> {
    setMicError(null);
    setStarting(true);
    try {
      await store.startRecording({ title: title.trim() || t('screen.new.untitled'), language, translationLang: translationLang === language ? defaultTranslationTarget(language) : translationLang, translationEnabled });
      onStarted();
    } catch (error) {
      // Keep the raw cause for diagnosis; the on-screen text is classified below.
      console.error('startRecording failed', error);
      const name = error instanceof DOMException ? error.name : '';
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        setMicError(t('screen.new.micDenied')); // user/policy denied the mic prompt
      } else if (name === 'NotSupportedError') {
        setMicError(t('screen.new.micUnavailable')); // iframe not granted allow="microphone"
      } else if (name) {
        setMicError(t('screen.new.micError')); // NotFound/NotReadable — real device fault
      } else {
        // Surface the real cause: the generic message hid folder/token/relay
        // failures and forced blind server-side debugging.
        const detail = error instanceof Error ? error.message : String(error);
        setMicError(`${t('screen.new.startFailed')} [${detail}]`); // mic was fine; a later start step failed
      }
    } finally {
      setStarting(false);
    }
  }

  return (
    <div className="ma-new-meeting">
      <h2 className="ma-new-meeting__title">{t('screen.new.title')}</h2>
      <p className="ma-new-meeting__subtitle">{t('screen.new.subtitle')}</p>

      <label className="ma-field">
        <span className="ma-field__label">{t('screen.new.meetingTitle')}</span>
        <input
          className="ma-field__input"
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={t('screen.new.untitled')}
        />
      </label>

      <label className="ma-field">
        <span className="ma-field__label">{t('screen.new.language')}</span>
        <select className="ma-field__input" value={language} onChange={(e) => setLanguage(e.target.value as Language)}>
          {SUPPORTED_LANGUAGES.map((code) => (
            <option key={code} value={code}>{LANGUAGE_ENDONYMS[code]}</option>
          ))}
        </select>
      </label>

      <label className="ma-field ma-field--checkbox">
        <input type="checkbox" checked={translationEnabled} onChange={(e) => setTranslationEnabled(e.target.checked)} />
        <span>{t('screen.new.translation')}</span>
      </label>

      {translationEnabled ? (
        <label className="ma-field">
          <span className="ma-field__label">{t('screen.new.translationTarget')}</span>
          <select className="ma-field__input" value={translationLang} onChange={(e) => setTranslationLang(e.target.value as Language)}>
            {SUPPORTED_LANGUAGES.filter((code) => code !== language).map((code) => (
              <option key={code} value={code}>{LANGUAGE_ENDONYMS[code]}</option>
            ))}
          </select>
        </label>
      ) : null}

      <div className="ma-new-meeting__readonly">
        <div>
          <Icon name="chat" size={16} />
          <span>{context.roomName || context.roomId}</span>
        </div>
        <div>
          <Icon name="shield-keyhole" size={16} />
          <span>{t('screen.new.provider', { provider: provider ?? '…' })}</span>
        </div>
      </div>

      {micError ? <p className="ma-new-meeting__error">{micError}</p> : null}

      <button type="button" className="ma-new-meeting__start" disabled={starting} onClick={() => void handleStart()}>
        <Icon name="record" size={18} />
        {starting ? t('screen.new.starting') : t('screen.new.start')}
      </button>
    </div>
  );
}
