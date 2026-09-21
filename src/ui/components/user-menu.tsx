/**
 * Account menu that pops up from the rail avatar. Holds what used to live in the
 * top bar — appearance (light/dark) and language (vi/en) — so the header can be
 * removed and the screen content lifted up.
 */
import { SUPPORTED_LANGUAGES, useI18n } from '../i18n/i18n-provider.js';
import { LANGUAGE_ENDONYMS } from '../i18n/languages.js';
import { useTheme } from '../theme/theme-provider.js';
import { Icon } from './icon.js';

export interface UserMenuProps {
  username?: string;
  onClose(): void;
}

export function UserMenu({ username, onClose }: UserMenuProps) {
  const { language, setLanguage, t } = useI18n();
  const { mode, setMode } = useTheme();
  // Tap cycles to the next language, wrapping around — a picker in this small popover would crowd it.
  const nextLanguage = SUPPORTED_LANGUAGES[(SUPPORTED_LANGUAGES.indexOf(language) + 1) % SUPPORTED_LANGUAGES.length];
  // Cycle Auto (follow the Hub) -> Light -> Dark -> Auto, so the initial
  // Hub-following state is always reachable again, not a one-way override.
  const nextMode = mode === 'auto' ? 'light' : mode === 'light' ? 'dark' : 'auto';

  return (
    <>
      <button type="button" className="ma-user-menu__backdrop" aria-label={t('userMenu.close')} onClick={onClose} />
      <div className="ma-user-menu" role="menu" aria-label={t('userMenu.title')}>
        {username ? <div className="ma-user-menu__name">{username}</div> : null}
        <button
          type="button"
          role="menuitem"
          className="ma-user-menu__item"
          onClick={() => setMode(nextMode)}
        >
          <Icon name="lightbulb" size={16} />
          <span className="ma-user-menu__label">{t('userMenu.theme')}</span>
          <span className="ma-user-menu__value">{t(`userMenu.theme.${mode}`)}</span>
        </button>
        <button type="button" role="menuitem" className="ma-user-menu__item" onClick={() => setLanguage(nextLanguage)}>
          <Icon name="globe" size={16} />
          <span className="ma-user-menu__label">{t('topbar.language.label')}</span>
          <span className="ma-user-menu__value">{LANGUAGE_ENDONYMS[language]}</span>
        </button>
      </div>
    </>
  );
}
