import { EmptyState } from '../components/empty-state.js';
import { useI18n } from '../i18n/i18n-provider.js';

export function NewMeetingScreen() {
  const { t } = useI18n();
  return <EmptyState icon="record" title={t('screen.new.title')} subtitle={t('screen.new.subtitle')} />;
}
