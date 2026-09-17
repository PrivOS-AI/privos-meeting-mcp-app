import { EmptyState } from '../components/empty-state.js';
import { useI18n } from '../i18n/i18n-provider.js';

export function SettingsScreen() {
  const { t } = useI18n();
  return <EmptyState icon="settings" title={t('screen.settings.title')} subtitle={t('screen.settings.subtitle')} />;
}
