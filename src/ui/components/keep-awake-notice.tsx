/**
 * Fallback banner shown whenever the Screen Wake Lock could not be acquired
 * (Hub has not granted `allow="screen-wake-lock"` yet, or the browser does
 * not support the API). Recording itself never depends on this — it only
 * tells the user to turn off their OS's screen/sleep timer by hand.
 */
import { useI18n } from '../i18n/i18n-provider.js';
import { Icon } from './icon.js';

export function KeepAwakeNotice() {
  const { t } = useI18n();
  return (
    <div className="ma-notice ma-notice--warning" role="status">
      <Icon name="alert-circle" size={16} />
      <span>{t('recording.keepAwake.notice')}</span>
    </div>
  );
}
