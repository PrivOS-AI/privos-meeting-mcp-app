/**
 * 64px vertical navigation rail.
 *
 * The design calls for five rail icons (new/history/bookmarks/search/
 * settings), but Phase 1 only ships screens for three of them — "live" and
 * "detail" are reached later (starting a recording, opening a history row),
 * not from the rail, and "bookmarks"/"search" have no screen yet. Those two
 * render as inert placeholders so the rail matches the design now without
 * inventing routes or screens this phase does not own.
 */
import { usePrivosContext } from '@privos_ai/app-react';

import type { Route } from '../app.js';
import { useI18n } from '../i18n/i18n-provider.js';
import { Icon, type IconName } from './icon.js';

interface RailItem {
  route: Route | null;
  icon: IconName;
  labelKey: string;
}

const RAIL_ITEMS: RailItem[] = [
  { route: 'new', icon: 'record', labelKey: 'rail.new' },
  { route: 'history', icon: 'history', labelKey: 'rail.history' },
  { route: null, icon: 'bookmark', labelKey: 'rail.bookmarks' },
  { route: null, icon: 'search', labelKey: 'rail.search' },
  { route: 'settings', icon: 'settings', labelKey: 'rail.settings' },
];

export interface AppRailProps {
  current: Route;
  onNavigate(route: Route): void;
}

export function AppRail({ current, onNavigate }: AppRailProps) {
  const { t } = useI18n();
  const { username } = usePrivosContext();
  const initial = username ? username.trim().charAt(0).toUpperCase() : '?';

  return (
    <nav className="ma-rail" aria-label={t('app.title')}>
      <div className="ma-rail__items">
        {RAIL_ITEMS.map((item) => {
          const label = t(item.labelKey);
          const active = item.route !== null && item.route === current;
          return (
            <button
              key={item.labelKey}
              type="button"
              className={`ma-rail__item${active ? ' ma-rail__item--active' : ''}`}
              aria-label={label}
              aria-current={active ? 'page' : undefined}
              title={label}
              disabled={item.route === null}
              onClick={item.route ? () => onNavigate(item.route as Route) : undefined}
            >
              <Icon name={item.icon} size={22} />
            </button>
          );
        })}
      </div>
      <div className="ma-rail__spacer" />
      <div className="ma-rail__avatar" title={username || undefined} aria-hidden="true">
        {initial}
      </div>
    </nav>
  );
}
