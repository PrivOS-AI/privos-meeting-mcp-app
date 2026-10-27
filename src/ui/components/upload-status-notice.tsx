/**
 * Live-screen notice for the recording's own audio, which the part-upload queue
 * otherwise retries silently: parts still waiting to reach Files (the tab must
 * stay open and online), parts lost after the retry window, too many parts
 * queued, or a recorder failure. Captions are unaffected either way; the final
 * transcript is built only from the uploaded parts.
 */
import { useI18n } from '../i18n/i18n-provider.js';
import { Icon } from './icon.js';

/** One part waiting is normal (it was just cut); two or more means uploads are falling behind. */
const BACKLOG_NOTICE_AT = 2;

interface UploadStatusNoticeProps {
  pendingParts: number;
  lostParts: number;
  issue?: 'cap-reached' | 'window-expired' | 'recorder-error';
}

export function UploadStatusNotice({ pendingParts, lostParts, issue }: UploadStatusNoticeProps) {
  const { t } = useI18n();
  let text: string | null = null;
  let tone: 'warning' | 'error' = 'warning';
  if (issue === 'recorder-error') {
    text = t('recording.upload.recorderError');
    tone = 'error';
  } else if (issue === 'window-expired') {
    text = t('recording.upload.lost', { n: lostParts });
    tone = 'error';
  } else if (issue === 'cap-reached') {
    text = t('recording.upload.capReached');
    tone = 'error';
  } else if (pendingParts >= BACKLOG_NOTICE_AT) {
    text = t('recording.upload.pending', { n: pendingParts });
  }
  if (!text) return null;
  return (
    <div className={`ma-notice ma-notice--${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <Icon name="alert-circle" size={16} />
      <span>{text}</span>
    </div>
  );
}
