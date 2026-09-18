/**
 * Bookmarks list (phase-07 § Requirements: "Bookmark: thêm tại thời điểm
 * đang phát, xoá, click để seek"). Reused by the meeting detail screen
 * (seek + delete) and the live side panel (list-only, no player to seek).
 */
import { useI18n } from '../i18n/i18n-provider.js';
import { formatClock } from '../data/format-time.js';
import { Icon } from './icon.js';

export interface BookmarkItem {
  id: string;
  atSec: number;
  quote?: string;
}

export interface BookmarksPanelProps {
  bookmarks: BookmarkItem[];
  onSeek?(sec: number): void;
  onDelete?(id: string): void;
}

export function BookmarksPanel({ bookmarks, onSeek, onDelete }: BookmarksPanelProps) {
  const { t } = useI18n();
  if (bookmarks.length === 0) return <p className="ma-bookmarks-panel__empty">{t('bookmarks.empty')}</p>;

  return (
    <ul className="ma-bookmarks-panel__list">
      {bookmarks.map((bookmark) => (
        <li key={bookmark.id} className="ma-bookmarks-panel__row">
          <button type="button" className="ma-bookmarks-panel__seek" onClick={() => onSeek?.(bookmark.atSec)} disabled={!onSeek}>
            <Icon name="bookmark" size={14} /> {formatClock(bookmark.atSec)}
          </button>
          {bookmark.quote ? <span className="ma-bookmarks-panel__quote">{bookmark.quote}</span> : null}
          {onDelete ? (
            <button type="button" className="ma-bookmarks-panel__delete" onClick={() => onDelete(bookmark.id)} aria-label={t('bookmarks.delete')}>
              ×
            </button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
