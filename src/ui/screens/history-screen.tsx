/**
 * Screen 1d — History (phase-07 § Requirements): 4 stat cards, filter chips,
 * sort, keyword search, paginated table with a row menu. Rows/aux data load
 * once per page ("Load more" appends the next 50), never an unbounded query.
 */
import { useCallback, useEffect, useState } from 'react';
import { usePrivosApp, usePrivosContext } from '@privos_ai/app-react';

import { ConfirmDialog } from '../components/confirm-dialog.js';
import { EmptyState } from '../components/empty-state.js';
import { FilterChips, type FilterChipOption } from '../components/filter-chips.js';
import { Icon } from '../components/icon.js';
import { MeetingHistoryRow } from '../components/meeting-history-row.js';
import { SearchBox } from '../components/search-box.js';
import { StatCard } from '../components/stat-card.js';
import { searchMeetings } from '../data/keyword-search.js';
import { downloadMeetingDocx, downloadMeetingSrt } from '../data/meeting-export.js';
import {
  deleteMeeting,
  listActionItemCountsForMeetings,
  listMeetingIdsWithBookmarks,
  listMeetings,
  listSpeakersForMeetings,
  renameMeeting,
  type ActionItemCounts,
  type MeetingOrderBy,
  type MeetingReadModel,
  type MeetingSpeakerSummary,
} from '../data/meeting-read-model.js';
import { loadMeetingStats, type MeetingStats } from '../data/meeting-stats.js';
import { formatDurationLong } from '../data/format-time.js';
import { useI18n } from '../i18n/i18n-provider.js';

export interface HistoryScreenProps {
  onStartRecording(): void;
  onOpenMeeting(meetingId: string): void;
}

type FilterValue = 'all' | 'actionItems' | 'bookmarked' | 'mine';
type SortValue = 'newest' | 'oldest' | 'longest';
const PAGE_SIZE = 50;
const SORT_TO_ORDER_BY: Record<SortValue, MeetingOrderBy> = { newest: 'startedAt_desc', oldest: 'startedAt_asc', longest: 'durationSec_desc' };

export function HistoryScreen({ onStartRecording, onOpenMeeting }: HistoryScreenProps) {
  const app = usePrivosApp();
  const { roomId, userId } = usePrivosContext();
  const { t } = useI18n();

  const [stats, setStats] = useState<MeetingStats | null>(null);
  const [meetings, setMeetings] = useState<MeetingReadModel[]>([]);
  const [total, setTotal] = useState(0);
  const [speakersByMeeting, setSpeakersByMeeting] = useState<Record<string, MeetingSpeakerSummary[]>>({});
  const [actionCounts, setActionCounts] = useState<Record<string, ActionItemCounts>>({});
  const [bookmarkedIds, setBookmarkedIds] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<FilterValue>('all');
  const [sort, setSort] = useState<SortValue>('newest');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<MeetingReadModel | null>(null);
  // The id of the meeting currently being deleted — lets the row button show
  // "Deleting…" and stay disabled until the async operation settles.
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const loadPage = useCallback(
    async (offset: number, replace: boolean) => {
      if (!roomId) return;
      setLoading(true);
      setError(null);
      try {
        const page = await listMeetings(app, roomId, { limit: PAGE_SIZE, offset, orderBy: SORT_TO_ORDER_BY[sort] });
        const ids = page.meetings.map((m) => m._id);
        const [speakers, actionItemCounts, bookmarks] = await Promise.all([
          listSpeakersForMeetings(app, ids),
          listActionItemCountsForMeetings(app, ids),
          listMeetingIdsWithBookmarks(app, ids),
        ]);
        setTotal(page.total);
        setMeetings((prev) => (replace ? page.meetings : [...prev, ...page.meetings]));
        setSpeakersByMeeting((prev) => (replace ? speakers : { ...prev, ...speakers }));
        setActionCounts((prev) => (replace ? actionItemCounts : { ...prev, ...actionItemCounts }));
        setBookmarkedIds((prev) => (replace ? bookmarks : new Set([...prev, ...bookmarks])));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [app, roomId, sort],
  );

  useEffect(() => {
    void loadPage(0, true);
  }, [loadPage]);

  useEffect(() => {
    if (!roomId) return;
    loadMeetingStats(app, roomId)
      .then(setStats)
      .catch((err: unknown) => console.error('loadMeetingStats failed', err));
  }, [app, roomId, meetings.length]);

  async function handleRename(meeting: MeetingReadModel): Promise<void> {
    const next = window.prompt(t('history.renamePrompt'), meeting.title ?? '');
    if (next == null || next.trim() === '') return;
    await renameMeeting(app, meeting._id, next.trim());
    setMeetings((prev) => prev.map((m) => (m._id === meeting._id ? { ...m, title: next.trim() } : m)));
  }

  async function confirmDelete(): Promise<void> {
    const meeting = pendingDelete;
    if (!meeting) return;
    setPendingDelete(null);
    setDeletingId(meeting._id);
    try {
      await deleteMeeting(app, meeting);
      setMeetings((prev) => prev.filter((m) => m._id !== meeting._id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeletingId(null);
    }
  }

  async function runExport(action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const filtered = searchMeetings(
    meetings.filter((m) => {
      if (filter === 'mine') return m.ownerUserId === userId;
      if (filter === 'actionItems') return (actionCounts[m._id]?.total ?? 0) > 0;
      if (filter === 'bookmarked') return bookmarkedIds.has(m._id);
      return true;
    }),
    query,
  );

  const filterOptions: FilterChipOption<FilterValue>[] = [
    { value: 'all', label: t('history.filter.all') },
    { value: 'actionItems', label: t('history.filter.actionItems') },
    { value: 'bookmarked', label: t('history.filter.bookmarked') },
    { value: 'mine', label: t('history.filter.mine') },
  ];

  return (
    <div className="ma-history-screen">
      <div className="ma-history-screen__header">
        <SearchBox value={query} onChange={setQuery} placeholder={t('history.searchPlaceholder')} />
        <button type="button" className="ma-history-screen__start" onClick={onStartRecording}>
          <Icon name="record" size={16} /> {t('screen.new.start')}
        </button>
      </div>

      {stats ? (
        <div className="ma-history-screen__stats">
          <StatCard icon="calendar" label={t('history.stats.thisWeek')} value={String(stats.meetingsThisWeek)} />
          <StatCard icon="clock" label={t('history.stats.totalDuration')} value={formatDurationLong(stats.totalDurationSec)} />
          <StatCard icon="checkmark-circle" label={t('history.stats.openActionItems')} value={String(stats.openActionItems)} tone={stats.openActionItems > 0 ? 'warning' : 'default'} />
          <StatCard icon="bookmark" label={t('history.stats.bookmarks')} value={String(stats.bookmarkCount)} />
        </div>
      ) : null}

      <div className="ma-history-screen__controls">
        <FilterChips options={filterOptions} value={filter} onChange={(next) => setFilter(next)} />
        <select className="ma-history-screen__sort" value={sort} onChange={(e) => setSort(e.target.value as SortValue)}>
          <option value="newest">{t('history.sort.newest')}</option>
          <option value="oldest">{t('history.sort.oldest')}</option>
          <option value="longest">{t('history.sort.longest')}</option>
        </select>
      </div>

      {error ? (
        <p className="ma-history-screen__error" role="alert">
          {error}
        </p>
      ) : null}

      {filtered.length === 0 && !loading ? (
        <EmptyState icon="history" title={t('screen.history.title')} subtitle={t('screen.history.subtitle')} />
      ) : (
        <table className="ma-history-screen__table">
          <tbody>
            {filtered.map((meeting) => (
              <MeetingHistoryRow
                key={meeting._id}
                meeting={meeting}
                speakers={speakersByMeeting[meeting._id] ?? []}
                actionItemCount={actionCounts[meeting._id]?.total ?? 0}
                isOwner={meeting.ownerUserId === userId}
                isDeleting={deletingId === meeting._id}
                onOpen={() => onOpenMeeting(meeting._id)}
                onRename={() => void handleRename(meeting)}
                onExportSrt={() => void runExport(() => downloadMeetingSrt(app, meeting))}
                onExportDocx={() => void runExport(() => downloadMeetingDocx(app, meeting))}
                onDelete={() => setPendingDelete(meeting)}
              />
            ))}
          </tbody>
        </table>
      )}

      {meetings.length < total ? (
        <button type="button" className="ma-history-screen__load-more" disabled={loading} onClick={() => void loadPage(meetings.length, false)}>
          {loading ? t('history.loading') : t('history.loadMore')}
        </button>
      ) : null}

      {pendingDelete ? (
        <ConfirmDialog
          title={t('history.deleteConfirmTitle')}
          message={t('history.deleteConfirm')}
          confirmLabel={t('history.rowMenu.delete')}
          cancelLabel={t('history.deleteCancel')}
          danger
          onConfirm={() => void confirmDelete()}
          onCancel={() => setPendingDelete(null)}
        />
      ) : null}
    </div>
  );
}
