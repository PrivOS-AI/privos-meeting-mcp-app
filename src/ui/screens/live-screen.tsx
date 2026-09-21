/**
 * The live recording screen: toggles between 1a (light Transcript) and 1b
 * (dark Stage). Both share the same `RecordingStore` state and footer.
 */
import { useEffect, useRef, useState } from 'react';
import { usePrivosApp, usePrivosContext } from '@privos_ai/app-react';

import { BookmarksPanel } from '../components/bookmarks-panel.js';
import { CapacityNotice } from '../components/capacity-notice.js';
import { CaptionLine } from '../components/caption-line.js';
import { DegradedLabelsNotice } from '../components/degraded-labels-notice.js';
import { EmptyState } from '../components/empty-state.js';
import { Icon } from '../components/icon.js';
import { KeepAwakeNotice } from '../components/keep-awake-notice.js';
import { LiveSummaryPanel } from '../components/live-summary-panel.js';
import { VoiceWaveform } from '../components/voice-waveform.js';
import { RecIndicator } from '../components/rec-indicator.js';
import { RecordingFooter } from '../components/recording-footer.js';
import { StageCaption } from '../components/stage-caption.js';
import { deleteBookmark, listBookmarks, type BookmarkRecord } from '../data/bookmark-read-model.js';
import { useI18n } from '../i18n/i18n-provider.js';
import { resolveLineSpeakerKey, useRecordingState, useRecordingStore } from '../stores/recording-store.js';

export interface LiveScreenProps {
  onEnded(): void;
}

type ViewMode = 'transcript' | 'stage';

export function LiveScreen({ onEnded }: LiveScreenProps) {
  const { t } = useI18n();
  const { roomId } = usePrivosContext();
  const store = useRecordingStore();
  const state = useRecordingState();
  const [view, setView] = useState<ViewMode>('transcript');
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  // Shared across every caption line so the whole column flips together.
  const [timeMode, setTimeMode] = useState<'clock' | 'wall'>('clock');
  // Mobile only: the Summary/Bookmarks panel is a right-hand drawer.
  const [sideOpen, setSideOpen] = useState(false);

  // Chat-style transcript: keep the newest caption in view so older lines are
  // pushed up as people talk — but never yank the view while the user has
  // scrolled up to read history (only follow when already near the bottom).
  const linesRef = useRef<HTMLDivElement | null>(null);
  const followRef = useRef(true);
  const lastLine = state.lines[state.lines.length - 1];
  useEffect(() => {
    const el = linesRef.current;
    if (el && followRef.current) el.scrollTop = el.scrollHeight;
  }, [state.lines.length, lastLine?.text, lastLine?.translation]);
  // (hooks above must stay before the idle early-return below — Rules of Hooks)

  if (state.status === 'idle') {
    return <EmptyState icon="microphone" title={t('screen.live.title')} subtitle={t('screen.live.subtitle')} />;
  }

  const speakerKeys = Object.keys(state.speakerMap);
  const speakerLabel = (key: string): string => state.speakerMap[key]?.displayName ?? t('recording.speakerBadge.numbered', { n: speakerKeys.indexOf(key) + 1 });
  // Every known speaker (diarized + manually added) — feeds the per-line picker and the waveform.
  const pickerSpeakers = speakerKeys.map((key) => ({ speakerKey: key, label: speakerLabel(key), colorKey: state.speakerMap[key].colorKey }));
  const newestLine = state.lines[state.lines.length - 1];
  const activeSpeakerKey = newestLine ? resolveLineSpeakerKey(state, newestLine) : undefined;

  async function handleEnd(): Promise<void> {
    await store.endAndSummarize();
    onEnded();
  }

  const footer = (
    <RecordingFooter
      muted={state.muted}
      paused={state.status === 'paused'}
      ending={state.status === 'ending'}
      waveform={<VoiceWaveform stream={store.getStream()} muted={state.muted} speakers={pickerSpeakers} activeKey={activeSpeakerKey} />}
      onToggleMute={() => store.toggleMute()}
      onTogglePause={() => store.togglePause()}
      onEnd={() => void handleEnd()}
    />
  );

  const notices = (
    <>
      {!state.wakeLock.supported || state.wakeLock.error ? <KeepAwakeNotice /> : null}
      {state.captionStatus === 'capacity' ? <CapacityNotice /> : null}
      {state.capabilities && !state.capabilities.speakerLabels ? <DegradedLabelsNotice /> : null}
    </>
  );

  if (view === 'stage') {
    return (
      <div className="ma-stage">
        <div className="ma-stage__topbar">
          <RecIndicator elapsedSec={state.elapsedSec} paused={state.status === 'paused'} />
          <span className="ma-stage__status">
            {state.provider ?? '…'} · {t(`recording.captionStatus.${state.captionStatus}`)}
          </span>
          <button type="button" className="ma-stage__toggle" onClick={() => setView('transcript')}>
            <Icon name="document" size={16} />
            {t('recording.view.transcript')}
          </button>
        </div>
        {notices}
        <StageCaption lines={state.lines} speakerMap={state.speakerMap} size={state.stageCaptionSize} resolveSpeakerKey={(line) => resolveLineSpeakerKey(state, line)} />
        <div className="ma-stage__footer">{footer}</div>
      </div>
    );
  }

  return (
    <div className="ma-live">
      <div className="ma-live__main">
        <div className="ma-live__topbar">
          <div className="ma-live__title-wrap">
            {editingTitle ? (
              <input
                className="ma-live__title-input"
                value={titleDraft}
                autoFocus
                maxLength={300}
                onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={() => { store.setTitle(titleDraft); setEditingTitle(false); }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { store.setTitle(titleDraft); setEditingTitle(false); }
                  if (e.key === 'Escape') setEditingTitle(false);
                }}
              />
            ) : (
              <button
                type="button"
                className="ma-live__title"
                onClick={() => { setTitleDraft(state.title); setEditingTitle(true); }}
                aria-label={t('recording.editTitle')}
              >
                <span className="ma-live__title-text">{state.title}</span>
                <Icon name="edit" size={15} />
              </button>
            )}
          </div>
          <div className="ma-live__topbar-actions">
            <span className="ma-live__meta">
              <Icon name="person-multiple" size={14} />
              {speakerKeys.length > 0 ? t('recording.speakerCount', { n: speakerKeys.length }) : t('recording.speakerCount.unknown')}
              {state.liveSpeakersDegraded ? (
                <button type="button" className="ma-live__degraded" title={t('recording.speakerChips.degraded')} aria-label={t('recording.speakerChips.degraded')}>
                  <Icon name="alert-circle" size={14} />
                </button>
              ) : null}
            </span>
            <button type="button" className="ma-live__toggle" onClick={() => setView('stage')}>
              <Icon name="volume" size={16} />
              {t('recording.view.stage')}
            </button>
            <button type="button" className="ma-live__side-toggle" onClick={() => setSideOpen(true)} aria-label={t('recording.side.open')}>
              <Icon name="sparkle" size={18} />
            </button>
          </div>
        </div>
        {notices}
        <div
          className="ma-live__lines"
          ref={linesRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
        >
          {state.lines.length === 0 ? (
            <p className="ma-live__waiting">{t('recording.waitingForCaptions')}</p>
          ) : (
            state.lines.map((line) => {
              const effectiveKey = resolveLineSpeakerKey(state, line);
              return (
                <CaptionLine
                  key={line.id}
                  line={line}
                  speakerKey={effectiveKey}
                  speaker={effectiveKey ? state.speakerMap[effectiveKey] : undefined}
                  speakerIndex={effectiveKey ? speakerKeys.indexOf(effectiveKey) + 1 : 0}
                  roomId={roomId}
                  speakers={state.capabilities?.speakerLabels ? pickerSpeakers : []}
                  onReassign={(toKey, applyToVoice) => store.reassignLine(line.id, toKey, applyToVoice)}
                  onAddSpeaker={(name, applyToVoice) => store.reassignLine(line.id, store.addManualSpeaker(name), applyToVoice)}
                  onRename={(speakerKey, choice) => store.assignRealtimeSpeaker(speakerKey, choice)}
                  timeMode={timeMode}
                  onToggleTimeMode={() => setTimeMode((m) => (m === 'clock' ? 'wall' : 'clock'))}
                  startedAtMs={state.startedAt}
                  bookmarked={state.bookmarkedSecs.includes(Math.round(line.atSec))}
                  onBookmark={() => void store.addBookmark(line.atSec, line.text)}
                />
              );
            })
          )}
        </div>
        {footer}
      </div>
      {sideOpen ? <button type="button" className="ma-live__side-scrim" aria-label={t('recording.side.close')} onClick={() => setSideOpen(false)} /> : null}
      <aside className={`ma-live__side${sideOpen ? ' ma-live__side--open' : ''}`}>
        <button type="button" className="ma-live__side-close" onClick={() => setSideOpen(false)} aria-label={t('recording.side.close')}>
          <Icon name="close" size={18} />
        </button>
        <LiveSidePanel meetingId={state.meetingId} bookmarkAtSec={state.bookmarkAtSec} />
      </aside>
    </div>
  );
}

type SideTab = 'summary' | 'bookmarks';

interface LiveSidePanelProps {
  meetingId: string | null;
  /** Changes every time a bookmark is added during this session — the trigger to refetch the list below. */
  bookmarkAtSec?: number;
}

/**
 * Summary/action items only exist once processing finishes (P6 backend
 * writes them from the finished transcript), so those two tabs stay the
 * "available after the meeting ends" placeholder during a live session.
 * Bookmarks, in contrast, are written live (`recording-store.ts#addBookmark`)
 * and worth showing immediately — reuses P7's `bookmarks-panel.tsx`.
 */
function LiveSidePanel({ meetingId, bookmarkAtSec }: LiveSidePanelProps) {
  const app = usePrivosApp();
  const { t } = useI18n();
  const [tab, setTab] = useState<SideTab>('summary');
  const [bookmarks, setBookmarks] = useState<BookmarkRecord[]>([]);
  // Summary + action items share ONE tab (action items render under the summary),
  // matching the design; both are written by the post-meeting job, so they show
  // the "available after the meeting ends" note during a live session.
  const TABS: Array<{ id: SideTab; icon: 'sparkle' | 'bookmark'; labelKey: string }> = [
    { id: 'summary', icon: 'sparkle', labelKey: 'recording.side.summary' },
    { id: 'bookmarks', icon: 'bookmark', labelKey: 'recording.side.bookmarks' },
  ];

  useEffect(() => {
    if (!meetingId || tab !== 'bookmarks') return;
    listBookmarks(app, meetingId)
      .then(setBookmarks)
      .catch(() => setBookmarks([]));
  }, [app, meetingId, tab, bookmarkAtSec]);

  async function removeBookmark(id: string): Promise<void> {
    await deleteBookmark(app, id);
    setBookmarks((prev) => prev.filter((b) => b.id !== id));
  }

  return (
    <div className="ma-side-panel">
      <div className="ma-side-panel__tabs" role="tablist">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className={`ma-side-panel__tab${tab === item.id ? ' ma-side-panel__tab--active' : ''}`}
            onClick={() => setTab(item.id)}
          >
            <Icon name={item.icon} size={16} />
            {t(item.labelKey)}
          </button>
        ))}
      </div>
      <div className="ma-side-panel__body">
        {tab === 'bookmarks' ? (
          <BookmarksPanel bookmarks={bookmarks} onDelete={(id) => void removeBookmark(id)} />
        ) : (
          <LiveSummaryPanel />
        )}
      </div>
    </div>
  );
}
