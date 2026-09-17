/**
 * 60px top bar: current screen title on the left, language and theme controls
 * on the right. Only two languages ship (vi/en), so the language control is a
 * single toggle rather than a dropdown — a "globe" marks the language section,
 * "translate" is the switch action itself.
 */
import { SUPPORTED_LANGUAGES, useI18n } from '../i18n/i18n-provider.js';
import { useTheme, type ThemeMode } from '../theme/theme-provider.js';
import { Icon } from './icon.js';

const ENDONYMS: Record<string, string> = { vi: 'VI', en: 'EN' };

const THEME_CYCLE: ThemeMode[] = ['auto', 'light', 'dark'];

export interface TopBarProps {
  title: string;
}

export function TopBar({ title }: TopBarProps) {
  const { language, setLanguage, t } = useI18n();
  const { mode, setMode } = useTheme();

  const otherLanguage = SUPPORTED_LANGUAGES.find((code) => code !== language) ?? language;

  function cycleTheme() {
    const currentIndex = THEME_CYCLE.indexOf(mode);
    const next = THEME_CYCLE[(currentIndex + 1) % THEME_CYCLE.length];
    setMode(next);
  }

  return (
    <header className="ma-topbar">
      <h1 className="ma-topbar__title">{title}</h1>
      <div className="ma-topbar__actions">
        <div role="group" aria-label={t('topbar.language.label')} className="ma-topbar__lang-group">
          <Icon name="globe" size={16} />
          <button
            type="button"
            className="ma-topbar__action"
            aria-label={t('topbar.language.label')}
            title={t('topbar.language.label')}
            onClick={() => setLanguage(otherLanguage)}
          >
            <Icon name="translate" size={16} />
            <span>{ENDONYMS[language] ?? language}</span>
          </button>
        </div>
        <button
          type="button"
          className="ma-topbar__action"
          aria-label={t('topbar.theme.toggle')}
          title={t('topbar.theme.toggle')}
          onClick={cycleTheme}
        >
          <Icon name="lightbulb" size={16} />
        </button>
      </div>
    </header>
  );
}
