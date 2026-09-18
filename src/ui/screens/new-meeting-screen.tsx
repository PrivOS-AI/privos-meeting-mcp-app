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
      const name = error instanceof DOMException ? error.name : '';
      setMicError(name === 'NotAllowedError' ? t('screen.new.micDenied') : t('screen.new.micError'));
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

      <button type="button" className="ma-new-meeting__start" disabled={starting} onClick={() => void handleStart()}>
        <Icon name="record" size={18} />
        {starting ? t('screen.new.starting') : t('screen.new.start')}
      </button>
    </div>
  );
}
