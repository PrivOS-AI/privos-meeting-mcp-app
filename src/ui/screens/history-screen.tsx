import { EmptyState } from '../components/empty-state.js';
import { useI18n } from '../i18n/i18n-provider.js';

export function HistoryScreen() {
  const { t } = useI18n();
  return <EmptyState icon="history" title={t('screen.history.title')} subtitle={t('screen.history.subtitle')} />;
}
