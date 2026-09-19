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
import { useState } from 'react';
import { usePrivosContext } from '@privos_ai/app-react';

import type { Route } from '../app.js';
import { useI18n } from '../i18n/i18n-provider.js';
import { useRecordingState } from '../stores/recording-store.js';
import { Icon, type IconName } from './icon.js';
import { UserMenu } from './user-menu.js';

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
  /** Mobile drawer state — the rail slides off-canvas until opened via the hamburger toggle. */
  open: boolean;
  onClose(): void;
}

export function AppRail({ current, onNavigate, open, onClose }: AppRailProps) {
  const { t } = useI18n();
  const { username } = usePrivosContext();
  const recording = useRecordingState();
  const initial = username ? username.trim().charAt(0).toUpperCase() : '?';
  const [menuOpen, setMenuOpen] = useState(false);
  // A live/paused/ending meeting makes its rail icon ripple so it reads as active.
  const meetingActive = recording.status === 'recording' || recording.status === 'paused' || recording.status === 'ending';

  return (
    <>
      {open ? <button type="button" className="ma-rail__scrim" aria-label={t('rail.close')} onClick={onClose} /> : null}
      <nav className={`ma-rail${open ? ' ma-rail--open' : ''}`} aria-label={t('app.title')}>
        <div className="ma-rail__items">
          {/* Mobile drawer only: Menu sits first, the (rippling) Meeting icon right below it. */}
          <button type="button" className="ma-rail__item ma-rail__menu" aria-label={t('rail.close')} title={t('rail.close')} onClick={onClose}>
            <Icon name="menu" size={22} />
          </button>
          {RAIL_ITEMS.map((item) => {
            const label = t(item.labelKey);
            const active = item.route !== null && item.route === current;
            const ripple = item.route === 'new' && meetingActive;
            return (
              <button
                key={item.labelKey}
                type="button"
                className={`ma-rail__item${active ? ' ma-rail__item--active' : ''}${ripple ? ' ma-rail__item--recording' : ''}`}
                aria-label={label}
                aria-current={active ? 'page' : undefined}
                title={label}
                disabled={item.route === null}
                onClick={
                  item.route
                    ? () => {
                        onNavigate(item.route as Route);
                        onClose();
                      }
                    : undefined
                }
              >
                <Icon name={item.icon} size={22} />
              </button>
            );
          })}
        </div>
        <div className="ma-rail__spacer" />
        <div className="ma-rail__avatar-wrap">
          <button
            type="button"
            className="ma-rail__avatar"
            title={username || undefined}
            aria-label={t('userMenu.title')}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
          >
            {initial}
          </button>
          {menuOpen ? <UserMenu username={username} onClose={() => setMenuOpen(false)} /> : null}
        </div>
      </nav>
    </>
  );
}
