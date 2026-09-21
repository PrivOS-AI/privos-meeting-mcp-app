/**
 * Screen 1c — Meeting detail, read-only (phase-07 § Requirements). Reuses the
 * live "meeting tab" shell (`.ma-live*` / `.ma-side-panel*`) so a history item
 * reads like the recording view — chat-style transcript column + a right drawer
 * — but WITHOUT any record controls. Playback (audio + scrubber), regenerate
 * summary, speaker relabel, bookmarks and SRT/DOCX/Share/Send-to-Chat stay; a
 * Back button returns to the history list. `transcript.json`/audio load once per
 * meetingId (cached by `transcript-loader.ts`).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePrivosApp, usePrivosContext } from '@privos_ai/app-react';

import { ActionItemsCard } from '../components/action-items-card.js';
import { AudioPlayer, type AudioPlayerHandle } from '../components/audio-player.js';
import { BookmarksPanel } from '../components/bookmarks-panel.js';
import { EmptyState } from '../components/empty-state.js';
import { Icon } from '../components/icon.js';
import { MeetingDetailActions } from '../components/meeting-detail-actions.js';
import { MeetingDetailSidePanel, type DetailSideTab } from '../components/meeting-detail-side-panel.js';
import { MeetingSpeakersPanel } from '../components/meeting-speakers-panel.js';
import { SaveToFilesModal } from '../components/save-to-files-modal.js';
import { StatusBadge } from '../components/status-badge.js';
import { SummaryCard } from '../components/summary-card.js';
import { TranscriptToolbar } from '../components/transcript-toolbar.js';
import { TranscriptView } from '../components/transcript-view.js';
import { addBookmarkAt, deleteBookmark, listBookmarks, type BookmarkRecord } from '../data/bookmark-read-model.js';
import { formatClock } from '../data/format-time.js';
import { searchTranscript, type Hit } from '../data/keyword-search.js';
import { listActionItems, type ActionItemRecord } from '../data/action-item-read-model.js';
import { downloadMeetingDocx, downloadMeetingSrt } from '../data/meeting-export.js';
import { getMeeting, listSpeakersForMeetings, renameMeeting, type MeetingReadModel, type MeetingSpeakerSummary } from '../data/meeting-read-model.js';
import { resolveFileUrl } from '../data/file-download.js';
import { loadTranscript, resolveAudioUrl, type TranscriptDoc } from '../data/transcript-loader.js';
import { useI18n } from '../i18n/i18n-provider.js';

export interface MeetingDetailScreenProps {
  meetingId: string;
  onBack(): void;
}

const SAVE_TO_FILES_ARTIFACTS: Array<{ labelKey: string; key: keyof MeetingReadModel }> = [
  { labelKey: 'saveToFiles.audio', key: 'audioFileId' },
  { labelKey: 'saveToFiles.transcriptJson', key: 'transcriptJsonFileId' },
  { labelKey: 'saveToFiles.transcriptMd', key: 'transcriptMdFileId' },
  { labelKey: 'saveToFiles.transcriptSrt', key: 'srtFileId' },
  { labelKey: 'saveToFiles.summary', key: 'summaryFileId' },
];

export function MeetingDetailScreen({ meetingId, onBack }: MeetingDetailScreenProps) {
  const app = usePrivosApp();
  const { roomId } = usePrivosContext();
  const { t } = useI18n();
  const playerRef = useRef<AudioPlayerHandle>(null);

  const [meeting, setMeeting] = useState<MeetingReadModel | null>(null);
  const [transcript, setTranscript] = useState<TranscriptDoc | null>(null);
  const [speakers, setSpeakers] = useState<MeetingSpeakerSummary[]>([]);
  const [actionItems, setActionItems] = useState<ActionItemRecord[]>([]);
  const [bookmarks, setBookmarks] = useState<BookmarkRecord[]>([]);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [audioErrored, setAudioErrored] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  const [currentSec, setCurrentSec] = useState(0);
  const [showTranslation, setShowTranslation] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [speakerFilter, setSpeakerFilter] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState('');
  const [hitIndex, setHitIndex] = useState(0);
  const [showSaveModal, setShowSaveModal] = useState(false);
  // Mobile only: the Summary/Speakers/Bookmarks panel is a right-hand drawer.
  const [sideOpen, setSideOpen] = useState(false);

  const reload = useCallback(async () => {
    if (!roomId) return;
    setLoading(true);
    setError(null);
    try {
      const record = await getMeeting(app, meetingId);
      setMeeting(record);
      const [speakerMap, items, bookmarkRows] = await Promise.all([
        listSpeakersForMeetings(app, [meetingId]),
        listActionItems(app, meetingId),
        listBookmarks(app, meetingId),
      ]);
      setSpeakers(speakerMap[meetingId] ?? []);
      setActionItems(items);
      setBookmarks(bookmarkRows);
      if (record?.transcriptJsonFileId) setTranscript(await loadTranscript(app, record.transcriptJsonFileId));
      if (record?.audioFileId) {
        setAudioErrored(false);
        setAudioUrl(await resolveAudioUrl(app, record.audioFileId));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [app, meetingId, roomId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function retryAudioUrl(): Promise<void> {
    if (!meeting?.audioFileId || audioErrored) return;
    setAudioErrored(true);
    try {
      setAudioUrl(await resolveAudioUrl(app, meeting.audioFileId));
    } catch {
      // Leaves the player showing its native error state — presigned URL retry exhausted (phase-07 risk table).
    }
  }

  const displayNameBySpeaker = useMemo(() => Object.fromEntries(speakers.map((s) => [s.speakerId, s.displayName])), [speakers]);
  const colorKeyBySpeaker = useMemo(() => Object.fromEntries(speakers.map((s) => [s.speakerId, s.colorKey])), [speakers]);
  const segments = transcript?.segments ?? [];
  const hasTranslation = segments.some((s) => Boolean(s.translation));

  const hits: Hit[] = useMemo(() => searchTranscript(segments, searchQuery), [segments, searchQuery]);
  const activeHit = hits[hitIndex] ?? null;
  const activeSegmentId = activeHit?.segmentId ?? segments.find((s) => s.startSec <= currentSec && currentSec < s.endSec)?.id;

  function seek(sec: number): void {
    playerRef.current?.seek(sec);
    playerRef.current?.play();
    setCurrentSec(sec);
  }

  function toggleSpeakerFilter(speakerId: string): void {
    setSpeakerFilter((prev) => {
      const next = new Set(prev);
      if (next.has(speakerId)) next.delete(speakerId);
      else next.add(speakerId);
      return next;
    });
  }

  async function saveTitle(): Promise<void> {
    if (titleDraft == null || !meeting) return;
    const next = titleDraft.trim();
    setTitleDraft(null);
    if (!next || next === meeting.title) return;
    await renameMeeting(app, meetingId, next);
    setMeeting((prev) => (prev ? { ...prev, title: next } : prev));
  }

  async function addBookmarkHere(): Promise<void> {
    await addBookmarkAt(app, meetingId, currentSec, '');
    setBookmarks(await listBookmarks(app, meetingId));
  }

  async function removeBookmark(id: string): Promise<void> {
    await deleteBookmark(app, id);
    setBookmarks((prev) => prev.filter((b) => b.id !== id));
  }

  async function shareSummary(): Promise<void> {
    if (!meeting?.summaryFileId) return;
    try {
      const { url } = await resolveFileUrl(app, meeting.summaryFileId, 'text/markdown');
      await navigator.clipboard.writeText(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function runExport(action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  if (!meeting) return <EmptyState icon="file-text" title={t('screen.detail.title')} subtitle={t('screen.detail.subtitle')} />;

  const sideTabs: DetailSideTab[] = [
    {
      id: 'summary',
      icon: 'sparkle',
      label: t('recording.side.summary'),
      node: (
        <SummaryCard
          roomId={roomId}
          meetingId={meetingId}
          summaryText={meeting.summaryText}
          keyTopics={meeting.keyTopics}
          summaryError={meeting.summaryError}
          onRegenerated={() => void reload()}
        />
      ),
    },
    {
      id: 'speakers',
      icon: 'person-multiple',
      label: t('detail.speakersTab'),
      node: (
        <MeetingSpeakersPanel
          roomId={roomId}
          meetingId={meetingId}
          speakers={speakers}
          onRelabeled={(speakerId, displayName) => setSpeakers((prev) => prev.map((s) => (s.speakerId === speakerId ? { ...s, displayName } : s)))}
        />
      ),
    },
    {
      id: 'actions',
      icon: 'checkmark-circle',
      label: t('recording.side.actions'),
      node: <ActionItemsCard roomId={roomId} meetingTitle={meeting.title ?? ''} items={actionItems} onSeek={seek} onChanged={() => void reload()} />,
    },
    {
      id: 'bookmarks',
      icon: 'bookmark',
      label: t('recording.side.bookmarks'),
      node: <BookmarksPanel bookmarks={bookmarks} onSeek={seek} onDelete={(id) => void removeBookmark(id)} />,
    },
  ];

  return (
    <div className="ma-live ma-detail">
      <div className="ma-live__main">
        <div className="ma-live__topbar">
          <button type="button" className="ma-detail__back" onClick={onBack}>
            <Icon name="arrow-left" size={16} /> {t('detail.backToHistory')}
          </button>
          <div className="ma-live__title-wrap">
            {titleDraft != null ? (
              <input
                className="ma-live__title-input"
                value={titleDraft}
                autoFocus
                onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={() => void saveTitle()}
                onKeyDown={(e) => e.key === 'Enter' && void saveTitle()}
              />
            ) : (
              <button type="button" className="ma-live__title" onClick={() => setTitleDraft(meeting.title ?? '')} aria-label={t('recording.editTitle')}>
                <span className="ma-live__title-text">{meeting.title || t('screen.new.untitled')}</span>
                <Icon name="edit" size={15} />
              </button>
            )}
          </div>
          <div className="ma-live__topbar-actions">
            <span className="ma-live__meta">
              <Icon name="person-multiple" size={14} /> {speakers.length} {t('detail.speakers')}
            </span>
            <button type="button" className="ma-live__side-toggle" onClick={() => setSideOpen(true)} aria-label={t('recording.side.open')}>
              <Icon name="sparkle" size={18} />
            </button>
          </div>
        </div>

        <div className="ma-detail__meta">
          <span>{meeting.startedAt ? new Date(meeting.startedAt).toLocaleString() : '—'}</span>
          <span>{formatClock(meeting.durationSec ?? 0)}</span>
          <StatusBadge status={meeting.status} />
          {meeting.transcriptJsonFileId ? <span className="ma-detail__badge">{t('detail.savedOnPrivos')}</span> : null}
        </div>

        {error ? (
          <p className="ma-detail__error" role="alert">
            {error}
          </p>
        ) : null}

        <MeetingDetailActions
          roomId={roomId}
          meetingId={meetingId}
          canBookmark={Boolean(audioUrl)}
          canShare={Boolean(meeting.summaryFileId)}
          hasSummary={Boolean(meeting.summaryText)}
          sentToChatAt={meeting.sentToChatAt}
          onBookmarkHere={() => void addBookmarkHere()}
          onExportSrt={() => void runExport(() => downloadMeetingSrt(app, meeting))}
          onExportDocx={() => void runExport(() => downloadMeetingDocx(app, meeting))}
          onSaveToFiles={() => setShowSaveModal(true)}
          onShare={() => void shareSummary()}
          onSentToChat={() => void reload()}
        />

        <TranscriptToolbar
          query={searchQuery}
          onQueryChange={(q) => {
            setSearchQuery(q);
            setHitIndex(0);
          }}
          hitIndex={hitIndex}
          hitCount={hits.length}
          onPrevHit={() => setHitIndex((i) => (i - 1 + hits.length) % hits.length)}
          onNextHit={() => setHitIndex((i) => (i + 1) % hits.length)}
          speakers={speakers.map((s) => ({ speakerId: s.speakerId, displayName: s.displayName }))}
          speakerFilter={speakerFilter}
          onToggleSpeaker={toggleSpeakerFilter}
          hasTranslation={hasTranslation}
          showTranslation={showTranslation}
          onToggleTranslation={() => setShowTranslation((v) => !v)}
          autoScroll={autoScroll}
          onToggleAutoScroll={() => setAutoScroll((v) => !v)}
        />

        {loading && segments.length === 0 ? (
          <p className="ma-live__waiting">{t('history.loading')}</p>
        ) : (
          <TranscriptView
            segments={segments}
            displayNameBySpeaker={displayNameBySpeaker}
            colorKeyBySpeaker={colorKeyBySpeaker}
            activeSegmentId={activeHit ? activeHit.segmentId : activeSegmentId}
            showTranslation={showTranslation}
            highlightQuery={searchQuery || undefined}
            autoScroll={autoScroll}
            speakerFilter={speakerFilter}
            onSeek={seek}
          />
        )}

        {audioUrl ? (
          <div className="ma-detail__player">
            <AudioPlayer
              ref={playerRef}
              src={audioUrl}
              bookmarks={bookmarks.map((b) => ({ id: b.id, atSec: b.atSec }))}
              onTimeUpdate={setCurrentSec}
              onError={() => void retryAudioUrl()}
            />
          </div>
        ) : meeting.audioFileId ? null : (
          <p className="ma-detail__no-audio">{t('detail.audioDeleted')}</p>
        )}
      </div>

      {sideOpen ? <button type="button" className="ma-live__side-scrim" aria-label={t('recording.side.close')} onClick={() => setSideOpen(false)} /> : null}
      <aside className={`ma-live__side${sideOpen ? ' ma-live__side--open' : ''}`}>
        <button type="button" className="ma-live__side-close" onClick={() => setSideOpen(false)} aria-label={t('recording.side.close')}>
          <Icon name="close" size={18} />
        </button>
        <MeetingDetailSidePanel tabs={sideTabs} />
      </aside>

      {showSaveModal ? (
        <SaveToFilesModal
          title={meeting.title ?? ''}
          meetingId={meetingId}
          startedAt={meeting.startedAt}
          folderId={meeting.folderId}
          artifacts={SAVE_TO_FILES_ARTIFACTS.map((a) => ({ labelKey: a.labelKey, fileId: meeting[a.key] as string | undefined }))}
          onClose={() => setShowSaveModal(false)}
        />
      ) : null}
    </div>
  );
}
