/**
 * Shown when `captionStatus === 'capacity'` — `meeting_realtime_token` was
 * refused because the workspace is at `LIVE_MAX_CONCURRENT_RECORDINGS`.
 * Recording itself is unaffected; only live captions are unavailable.
 */
import { useI18n } from '../i18n/i18n-provider.js';
import { Icon } from './icon.js';

export function CapacityNotice() {
  const { t } = useI18n();
  return (
    <div className="ma-notice ma-notice--warning" role="status">
      <Icon name="alert-circle" size={16} />
      <span>{t('recording.capacity.notice')}</span>
    </div>
  );
}
