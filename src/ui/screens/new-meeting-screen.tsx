/**
 * "Start recording" form: title, primary language, read-only room + active STT
 * provider name, start button. `getUserMedia` runs inside this button's own
 * click handler (both for the mic permission gesture requirement AND the
 * Screen Wake Lock gesture requirement).
 */
import { useEffect, useState } from 'react';
import { parseToolResult, usePrivosApp, usePrivosContext } from '@privos_ai/app-react';

import { useI18n } from '../i18n/i18n-provider.js';
import { SUPPORTED_LANGUAGES, LANGUAGE_ENDONYMS, type Language } from '../i18n/languages.js';
import { defaultTranslationTarget } from '../../shared/languages.js';
import { loadLocalPreferences, saveLocalPreference } from '../data/local-preferences.js';
import { loadWorkspaceSettings } from '../data/settings-store.js';
import { useRecordingStore, type CaptureSource } from '../stores/recording-store.js';
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
  // Bilingual captions add latency + Hub-AI cost: the default is the user's own preference (off unless they set it).
  const [translationEnabled, setTranslationEnabled] = useState(prefs.showTranslation);
  // Voiceprint recognition is on for this room until the setting says otherwise; while on, the
  // recorder must confirm they told participants before the recording can start.
  const [recognitionOn, setRecognitionOn] = useState(true);
  const [noticeAcknowledged, setNoticeAcknowledged] = useState(false);
  const [provider, setProvider] = useState<string | null>(null);
  // The Room's shared browser (Remote Browser in a Meet call) can be recorded instead of the mic, when the deployment links the two apps.
  const [browserAudio, setBrowserAudio] = useState(false);
  const [source, setSource] = useState<CaptureSource>('mic');
  const [micError, setMicError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    app
      .callServerTool({ name: 'meeting_stt_status', arguments: {} })
      .then((raw) => {
        if (cancelled) return;
        const parsed = parseToolResult(raw) as { activeRealtimeProvider?: string; browserAudio?: boolean };
        setProvider(parsed?.activeRealtimeProvider ?? null);
        setBrowserAudio(parsed?.browserAudio === true);
      })
      .catch(() => {
        if (!cancelled) setProvider(null);
      });
    return () => {
      cancelled = true;
    };
  }, [app]);

  useEffect(() => {
    if (!context.roomId) return;
    let cancelled = false;
    loadWorkspaceSettings(app, context.roomId)
      .then((settings) => {
        if (!cancelled) setRecognitionOn(settings.speakerRecognition);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [app, context.roomId]);

  async function handleStart(): Promise<void> {
    setMicError(null);
    setStarting(true);
    // Remember the picked main language as the default for the next new meeting.
    saveLocalPreference('meetingLanguage', language);
    try {
      await store.startRecording({ title: title.trim() || t('screen.new.untitled'), language, translationLang: translationLang === language ? defaultTranslationTarget(language) : translationLang, translationEnabled, voiceprintNoticeAcknowledged: recognitionOn && noticeAcknowledged, captureSource: browserAudio ? source : 'mic' });
      onStarted();
    } catch (error) {
      // Keep the raw cause for diagnosis; the on-screen text is classified below.
      console.error('startRecording failed', error);
      const name = error instanceof DOMException ? error.name : '';
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        setMicError(t('screen.new.micDenied')); // user/policy denied the mic prompt
      } else if (name === 'NotSupportedError') {
        setMicError(t('screen.new.micUnavailable')); // iframe not granted allow="microphone"
      } else if (name === 'NotFoundError') {
        setMicError(t('screen.new.micNotFound')); // no capture device on this machine
      } else if (name === 'NotReadableError') {
        setMicError(t('screen.new.micBusy')); // mic exists but is held by another app/tab
      } else if (name) {
        setMicError(t('screen.new.micError')); // other device faults — mic present but unusable
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

  const needsAcknowledgement = recognitionOn && !noticeAcknowledged;

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

      {browserAudio ? (
        <fieldset className="ma-field ma-new-meeting__source">
          <legend className="ma-field__label">{t('screen.new.source')}</legend>
          {(['mic', 'browser'] as const).map((value) => (
            <label key={value} className="ma-field ma-field--checkbox">
              <input type="radio" name="ma-capture-source" value={value} checked={source === value} onChange={() => setSource(value)} />
              <Icon name={value === 'mic' ? 'microphone' : 'globe'} size={16} />
              <span>{t(value === 'mic' ? 'screen.new.sourceMic' : 'screen.new.sourceBrowser')}</span>
            </label>
          ))}
          {source === 'browser' ? (
            <p className="ma-notice ma-notice--info">
              <Icon name="lightbulb" size={16} />
              <span>{t('screen.new.sourceBrowserHint')}</span>
            </p>
          ) : null}
        </fieldset>
      ) : null}

      <label className="ma-field">
        <span className="ma-field__label">{t('screen.new.language')}</span>
        <select className="ma-field__input" value={language} onChange={(e) => setLanguage(e.target.value as Language)}>
          {SUPPORTED_LANGUAGES.map((code) => (
            <option key={code} value={code}>{LANGUAGE_ENDONYMS[code]}</option>
          ))}
        </select>
      </label>
      {provider === 'local' && language !== 'vi' && language !== 'en' ? (
        <p className="ma-notice ma-notice--warning">
          <Icon name="alert-circle" size={16} />
          <span>{t('screen.new.localLanguageHint')}</span>
        </p>
      ) : null}

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
          <span>{t('screen.new.provider', { provider: providerName(provider, t) })}</span>
        </div>
      </div>

      {recognitionOn ? (
        <div className="ma-new-meeting__consent">
          <p className="ma-notice ma-notice--info">
            <Icon name="person-multiple" size={16} />
            <span>{t('screen.new.voiceprintNotice')}</span>
          </p>
          <label className="ma-field ma-field--checkbox">
            <input type="checkbox" checked={noticeAcknowledged} onChange={(e) => setNoticeAcknowledged(e.target.checked)} />
            <span>{t('screen.new.voiceprintAcknowledge')}</span>
          </label>
        </div>
      ) : null}

      {micError ? <p className="ma-new-meeting__error">{micError}</p> : null}

      <button
        type="button"
        className="ma-new-meeting__start"
        disabled={starting || needsAcknowledgement}
        aria-describedby={needsAcknowledgement ? 'ma-new-meeting-start-hint' : undefined}
        onClick={() => void handleStart()}
      >
        <Icon name="record" size={18} />
        {starting ? t('screen.new.starting') : t('screen.new.start')}
      </button>
      {needsAcknowledgement ? (
        <p id="ma-new-meeting-start-hint" className="ma-new-meeting__hint">
          {t('screen.new.acknowledgeFirst', { label: t('screen.new.voiceprintAcknowledge') })}
        </p>
      ) : null}
    </div>
  );
}

/** The provider's name as people know it; the raw key only for one this build does not know. */
function providerName(provider: string | null, t: (key: string) => string): string {
  if (provider === null) return '…';
  if (provider === 'local') return t('screen.new.providerLocal');
  if (provider === 'soniox') return 'Soniox';
  if (provider === 'elevenlabs') return 'ElevenLabs';
  return provider;
}
