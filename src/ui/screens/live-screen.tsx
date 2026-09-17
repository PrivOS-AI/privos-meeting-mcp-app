import { EmptyState } from '../components/empty-state.js';
import { useI18n } from '../i18n/i18n-provider.js';

export function LiveScreen() {
  const { t } = useI18n();
  return <EmptyState icon="microphone" title={t('screen.live.title')} subtitle={t('screen.live.subtitle')} />;
}
