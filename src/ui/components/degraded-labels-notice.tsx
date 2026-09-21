/**
 * Shown when `!capabilities.speakerLabels` (ElevenLabs realtime, D-18):
 * captions stay unlabeled during the meeting; real names/badges only arrive
 * from the post-meeting pass.
 */
import { useI18n } from '../i18n/i18n-provider.js';
import { Icon } from './icon.js';

export function DegradedLabelsNotice() {
  const { t } = useI18n();
  return (
    <div className="ma-notice ma-notice--info" role="status">
      <Icon name="person-multiple" size={16} />
      <span>{t('recording.degradedLabels.notice')}</span>
    </div>
  );
}
