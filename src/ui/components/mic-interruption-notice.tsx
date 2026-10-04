/**
 * Warns that audio was NOT captured for a stretch of the meeting (the machine
 * slept, or the mic capture died) and, while the mic is still down, offers the
 * click that reopens it — the host only grants the mic on a user gesture, so
 * the app cannot do this on its own.
 */
import { useState } from 'react';

import { useI18n } from '../i18n/i18n-provider.js';
import type { MicInterruption } from '../stores/recording-store.js';
import { Icon } from './icon.js';

export interface MicInterruptionNoticeProps {
  interruptions: MicInterruption[];
  resumeError?: string;
  onResume(): Promise<void>;
}

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function MicInterruptionNotice({ interruptions, resumeError, onResume }: MicInterruptionNoticeProps) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  if (interruptions.length === 0) return null;

  const last = interruptions[interruptions.length - 1];
  const closed = interruptions.filter((gap) => gap.toMs !== undefined);

  return (
    <>
      {last.toMs === undefined ? (
        <div className="ma-notice ma-notice--danger" role="alert">
          <Icon name="alert-circle" size={16} />
          <span>
            {t('recording.micLost.notice', { from: clock(last.fromMs) })}
            {resumeError ? ` ${t(resumeError === 'restart-unsupported' ? 'recording.micLost.unsupported' : 'recording.micLost.failed')}` : ''}
          </span>
          <button
            type="button"
            className="ma-notice__action"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void onResume().finally(() => setBusy(false));
            }}
          >
            <Icon name="microphone" size={14} /> {t('recording.micLost.resume')}
          </button>
        </div>
      ) : null}
      {closed.length > 0 ? (
        <div className="ma-notice ma-notice--warning" role="status">
          <Icon name="alert-circle" size={16} />
          <span>
            {t('recording.micLost.gaps', {
              ranges: closed.map((gap) => `${clock(gap.fromMs)}–${clock(gap.toMs!)}`).join(', '),
            })}
          </span>
        </div>
      ) : null}
    </>
  );
}
