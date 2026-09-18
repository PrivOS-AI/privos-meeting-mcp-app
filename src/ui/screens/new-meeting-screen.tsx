/**
 * "Bắt đầu ghi" form: title, primary language, read-only room + active STT
 * provider name, start button. `getUserMedia` runs inside this button's own
 * click handler (both for the mic permission gesture requirement AND the
 * Screen Wake Lock gesture requirement).
 */
import { useEffect, useState } from 'react';
import { parseToolResult, usePrivosApp, usePrivosContext } from '@privos_ai/app-react';

import { useI18n } from '../i18n/i18n-provider.js';
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

  const [title, setTitle] = useState('');
  const [language, setLanguage] = useState<'vi' | 'en'>('vi');
  const [translationEnabled, setTranslationEnabled] = useState(true);
  const [provider, setProvider] = useState<string | null>(null);
  const [micError, setMicError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  // TEMP mic diagnostic (opaque-origin vs missing allow="microphone") — runs
  // inside the exact iframe that fails, so it is readable on mobile without
  // desktop DevTools. Remove once the mic-access root cause is confirmed.
  const [micDiag, setMicDiag] = useState('');
  useEffect(() => {
    const fp = (document as unknown as { featurePolicy?: { allowsFeature?: (f: string) => boolean } }).featurePolicy;
    let micPolicy: string;
    try {
      micPolicy = typeof fp?.allowsFeature === 'function' ? String(fp.allowsFeature('microphone')) : 'n/a';
    } catch {
      micPolicy = 'err';
    }
    setMicDiag(`origin=${window.origin} · mediaDevices=${Boolean(navigator.mediaDevices)} · micPolicy=${micPolicy}`);
  }, []);

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
      await store.startRecording({ title: title.trim() || t('screen.new.untitled'), language, translationEnabled });
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
        setMicError(t('screen.new.startFailed')); // mic was fine; a later start step failed
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
        <select className="ma-field__input" value={language} onChange={(e) => setLanguage(e.target.value as 'vi' | 'en')}>
          <option value="vi">Tiếng Việt</option>
          <option value="en">English</option>
        </select>
      </label>

      <label className="ma-field ma-field--checkbox">
        <input type="checkbox" checked={translationEnabled} onChange={(e) => setTranslationEnabled(e.target.checked)} />
        <span>{t('screen.new.translation')}</span>
      </label>

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

      {micDiag ? (
        <p className="ma-new-meeting__subtitle" style={{ fontFamily: 'monospace', fontSize: 11, wordBreak: 'break-all' }}>
          mic-diag: {micDiag}
        </p>
      ) : null}

      <button type="button" className="ma-new-meeting__start" disabled={starting} onClick={() => void handleStart()}>
        <Icon name="record" size={18} />
        {starting ? t('screen.new.starting') : t('screen.new.start')}
      </button>
    </div>
  );
}
