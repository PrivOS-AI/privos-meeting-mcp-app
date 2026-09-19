/**
 * Account menu that pops up from the rail avatar. Holds what used to live in the
 * top bar — appearance (light/dark) and language (vi/en) — so the header can be
 * removed and the screen content lifted up.
 */
import { SUPPORTED_LANGUAGES, useI18n } from '../i18n/i18n-provider.js';
import { useTheme } from '../theme/theme-provider.js';
import { Icon } from './icon.js';

const ENDONYMS: Record<string, string> = { vi: 'Tiếng Việt', en: 'English' };

export interface UserMenuProps {
  username?: string;
  onClose(): void;
}

export function UserMenu({ username, onClose }: UserMenuProps) {
  const { language, setLanguage, t } = useI18n();
  const { theme, setMode } = useTheme();
  const otherLanguage = SUPPORTED_LANGUAGES.find((code) => code !== language) ?? language;

  return (
    <>
      <button type="button" className="ma-user-menu__backdrop" aria-label={t('userMenu.close')} onClick={onClose} />
      <div className="ma-user-menu" role="menu" aria-label={t('userMenu.title')}>
        {username ? <div className="ma-user-menu__name">{username}</div> : null}
        <button
          type="button"
          role="menuitem"
          className="ma-user-menu__item"
          aria-pressed={theme === 'dark'}
          onClick={() => setMode(theme === 'dark' ? 'light' : 'dark')}
        >
          <Icon name="lightbulb" size={16} />
          <span className="ma-user-menu__label">{t('userMenu.theme')}</span>
          <span className="ma-user-menu__value">{t(theme === 'dark' ? 'userMenu.theme.dark' : 'userMenu.theme.light')}</span>
        </button>
        <button type="button" role="menuitem" className="ma-user-menu__item" onClick={() => setLanguage(otherLanguage)}>
          <Icon name="globe" size={16} />
          <span className="ma-user-menu__label">{t('topbar.language.label')}</span>
          <span className="ma-user-menu__value">{ENDONYMS[language] ?? language}</span>
        </button>
      </div>
    </>
  );
}
