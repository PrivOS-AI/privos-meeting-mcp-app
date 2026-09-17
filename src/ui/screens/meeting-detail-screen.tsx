import { EmptyState } from '../components/empty-state.js';
import { useI18n } from '../i18n/i18n-provider.js';

export function MeetingDetailScreen() {
  const { t } = useI18n();
  return <EmptyState icon="file-text" title={t('screen.detail.title')} subtitle={t('screen.detail.subtitle')} />;
}
