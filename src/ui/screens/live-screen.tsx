/**
 * The live recording screen: toggles between 1a (light Transcript) and 1b
 * (dark Stage). Both share the same `RecordingStore` state and footer.
 */
import { useState } from 'react';
import { usePrivosContext } from '@privos_ai/app-react';

import { CapacityNotice } from '../components/capacity-notice.js';
import { CaptionLine } from '../components/caption-line.js';
import { DegradedLabelsNotice } from '../components/degraded-labels-notice.js';
import { EmptyState } from '../components/empty-state.js';
import { Icon } from '../components/icon.js';
import { KeepAwakeNotice } from '../components/keep-awake-notice.js';
import { LiveSpeakerChips } from '../components/live-speaker-chips.js';
import { MicLevelMeter } from '../components/mic-level-meter.js';
import { RecIndicator } from '../components/rec-indicator.js';
import { RecordingFooter } from '../components/recording-footer.js';
import { StageCaption } from '../components/stage-caption.js';
import { useI18n } from '../i18n/i18n-provider.js';
import { useRecordingState, useRecordingStore, type StageCaptionSize } from '../stores/recording-store.js';

export interface LiveScreenProps {
  onEnded(): void;
}

type ViewMode = 'transcript' | 'stage';

const SIZE_CYCLE: StageCaptionSize[] = ['small', 'medium', 'large'];

export function LiveScreen({ onEnded }: LiveScreenProps) {
  const { t } = useI18n();
  const { roomId } = usePrivosContext();
  const store = useRecordingStore();
  const state = useRecordingState();
  const [view, setView] = useState<ViewMode>('transcript');

  if (state.status === 'idle') {
    return <EmptyState icon="microphone" title={t('screen.live.title')} subtitle={t('screen.live.subtitle')} />;
  }

  const speakerKeys = Object.keys(state.speakerMap);

  async function handleEnd(): Promise<void> {
    await store.endAndSummarize();
    onEnded();
  }

  const speakerChips =
    state.meetingId && state.capabilities?.speakerLabels ? (
      <LiveSpeakerChips
        roomId={roomId}
        meetingId={state.meetingId}
        speakers={state.liveSpeakers}
        degraded={state.liveSpeakersDegraded}
        onResolved={(sessionSpeakerId, displayName) => store.applyQuickAssignResult(sessionSpeakerId, displayName)}
      />
    ) : null;

  const footer = (
    <RecordingFooter
      muted={state.muted}
      paused={state.status === 'paused'}
      stageCaptionSize={state.stageCaptionSize}
      ending={state.status === 'ending'}
      onToggleMute={() => store.toggleMute()}
      onCycleSize={() => store.setStageCaptionSize(SIZE_CYCLE[(SIZE_CYCLE.indexOf(state.stageCaptionSize) + 1) % SIZE_CYCLE.length])}
      onBookmark={() => void store.addBookmark()}
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
        {speakerChips}
        <StageCaption lines={state.lines} speakerMap={state.speakerMap} size={state.stageCaptionSize} />
        <div className="ma-stage__footer">{footer}</div>
      </div>
    );
  }

  return (
    <div className="ma-live">
      <div className="ma-live__main">
        <div className="ma-live__topbar">
          <div>
            <h2 className="ma-live__title">{state.title}</h2>
            <p className="ma-live__meta">
              <Icon name="person-multiple" size={14} />
              {speakerKeys.length > 0 ? t('recording.speakerCount', { n: speakerKeys.length }) : t('recording.speakerCount.unknown')}
            </p>
          </div>
          <div className="ma-live__topbar-actions">
            <RecIndicator elapsedSec={state.elapsedSec} paused={state.status === 'paused'} />
            <button type="button" className="ma-live__toggle" onClick={() => setView('stage')}>
              <Icon name="volume" size={16} />
              {t('recording.view.stage')}
            </button>
          </div>
        </div>
        {notices}
        {speakerChips}
        <div className="ma-live__lines">
          {state.lines.length === 0 ? (
            <p className="ma-live__waiting">{t('recording.waitingForCaptions')}</p>
          ) : (
            state.lines.map((line) => (
              <CaptionLine
                key={line.id}
                line={line}
                speaker={line.speakerKey ? state.speakerMap[line.speakerKey] : undefined}
                speakerIndex={line.speakerKey ? speakerKeys.indexOf(line.speakerKey) + 1 : 0}
                onBookmark={() => void store.addBookmark()}
              />
            ))
          )}
        </div>
        <MicLevelMeter stream={store.getStream()} muted={state.muted} />
        {footer}
      </div>
      <aside className="ma-live__side">
        <LiveSidePanel />
      </aside>
    </div>
  );
}

type SideTab = 'summary' | 'actions' | 'bookmarks';

function LiveSidePanel() {
  const { t } = useI18n();
  const [tab, setTab] = useState<SideTab>('summary');
  const TABS: Array<{ id: SideTab; icon: 'sparkle' | 'checkmark-circle' | 'bookmark'; labelKey: string }> = [
    { id: 'summary', icon: 'sparkle', labelKey: 'recording.side.summary' },
    { id: 'actions', icon: 'checkmark-circle', labelKey: 'recording.side.actions' },
    { id: 'bookmarks', icon: 'bookmark', labelKey: 'recording.side.bookmarks' },
  ];
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
        <p className="ma-side-panel__empty">{t('recording.side.emptyAfterEnd')}</p>
      </div>
    </div>
  );
}
