/**
 * Screen 1f — "Đang xử lý": polls `meeting_status` every 3s while the
 * background job concats parts, transcribes, segments and writes the
 * transcript. The 8 steps mirror `JobStep` in `src/server/jobs/job-repository.ts`
 * 1:1 so this screen never silently drifts from the backend's step enum.
 */
import { useEffect, useRef, useState } from 'react';
import { parseToolResult, usePrivosApp, usePrivosContext } from '@privos_ai/app-react';

import { ActionItemsCard } from '../components/action-items-card.js';
import { Icon } from '../components/icon.js';
import { ResolveSpeakersModal, type UnresolvedSpeaker } from '../components/resolve-speakers-modal.js';
import { SaveToFilesModal } from '../components/save-to-files-modal.js';
import { SendToChatButton } from '../components/send-to-chat-button.js';
import { SummaryCard } from '../components/summary-card.js';
import { listActionItems, type ActionItemRecord } from '../data/action-item-read-model.js';
import { getMeeting, type MeetingReadModel } from '../data/meeting-read-model.js';
import { useI18n } from '../i18n/i18n-provider.js';
import { useRecordingState } from '../stores/recording-store.js';

export interface ProcessingScreenProps {
  onDone(): void;
  /** Phase-07: lets "Xem chi tiết" jump straight to the meeting detail screen instead of History. */
  onOpenMeeting(meetingId: string): void;
}

const SAVE_TO_FILES_ARTIFACTS: Array<{ labelKey: string; key: keyof MeetingReadModel }> = [
  { labelKey: 'saveToFiles.audio', key: 'audioFileId' },
  { labelKey: 'saveToFiles.transcriptJson', key: 'transcriptJsonFileId' },
  { labelKey: 'saveToFiles.transcriptMd', key: 'transcriptMdFileId' },
  { labelKey: 'saveToFiles.transcriptSrt', key: 'srtFileId' },
  { labelKey: 'saveToFiles.summary', key: 'summaryFileId' },
];

const STEPS = ['download', 'decode', 'transcribe', 'segment', 'embed', 'summarize', 'write', 'cleanup'] as const;
type Step = (typeof STEPS)[number];

interface JobResultSpeakerDto {
  speakerId: string;
  totalSpeakSec: number;
  displayName?: string | null;
  confidence?: number;
  resolved?: boolean;
}

interface MeetingStatusResult {
  status: 'queued' | 'processing' | 'completed' | 'failed' | 'not_found';
  step: Step | null;
  progress: number;
  heartbeatAt: string | null;
  stale: boolean;
  provider?: string;
  error?: string;
  // P4: present once the job completes — drives the "Xác nhận người nói" modal below.
  result?: { speakers?: JobResultSpeakerDto[] };
}

const POLL_MS = 3000;

function stepState(index: number, status: MeetingStatusResult | null): 'done' | 'active' | 'pending' | 'failed' {
  if (!status) return 'pending';
  const currentIndex = status.step ? STEPS.indexOf(status.step) : -1;
  if (status.status === 'completed') return 'done';
  if (status.status === 'failed' && index === currentIndex) return 'failed';
  if (index < currentIndex) return 'done';
  if (index === currentIndex) return 'active';
  return 'pending';
}

export function ProcessingScreen({ onDone, onOpenMeeting }: ProcessingScreenProps) {
  const { t } = useI18n();
  const app = usePrivosApp();
  const context = usePrivosContext();
  const recording = useRecordingState();
  const meetingId = recording.meetingId;

  const [status, setStatus] = useState<MeetingStatusResult | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);
  const startedAtRef = useRef(Date.now());
  const [resolveModalDismissed, setResolveModalDismissed] = useState(false);

  // Phase 6/7: once the job completes, load the finished meeting record + action items and auto-open the
  // "Save to Files" confirmation once (dismissible) — phase-06 § Implementation Steps 12: "kết thúc → mở save-to-files-modal".
  const [completedMeeting, setCompletedMeeting] = useState<MeetingReadModel | null>(null);
  const [completedActionItems, setCompletedActionItems] = useState<ActionItemRecord[]>([]);
  const [showSaveModal, setShowSaveModal] = useState(false);
  const saveModalOpenedRef = useRef(false);

  async function loadCompletedMeeting(): Promise<void> {
    if (!meetingId) return;
    try {
      const [record, items] = await Promise.all([getMeeting(app, meetingId), listActionItems(app, meetingId)]);
      setCompletedMeeting(record);
      setCompletedActionItems(items);
    } catch (error) {
      console.error('Loading the completed meeting for the processing screen failed', error);
    }
  }

  useEffect(() => {
    if (!meetingId || !context.roomId) return undefined;
    let cancelled = false;
    async function poll(): Promise<void> {
      try {
        const raw = await app.callServerTool({ name: 'meeting_status', arguments: { roomId: context.roomId, meetingId } });
        const result = parseToolResult(raw) as unknown as MeetingStatusResult;
        if (!cancelled) setStatus(result);
      } catch {
        // Transient poll failure — the next tick retries; nothing to show yet.
      }
    }
    void poll();
    const timer = setInterval(() => void poll(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [app, context.roomId, meetingId]);

  useEffect(() => {
    if (status?.status === 'completed' || status?.status === 'failed') return undefined;
    const timer = setInterval(() => setElapsedSec(Math.floor((Date.now() - startedAtRef.current) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [status?.status]);

  async function retry(): Promise<void> {
    if (!meetingId) return;
    startedAtRef.current = Date.now();
    setElapsedSec(0);
    try {
      const raw = await app.callServerTool({ name: 'meeting_process', arguments: { roomId: context.roomId, meetingId } });
      parseToolResult(raw);
    } catch {
      // Surfaced on the next poll via `status.error`.
    }
  }

  const showRetry = status?.status === 'failed' || status?.stale === true;

  // P4: job `completed` with any `resolved:false` speaker -> open the modal
  // right away (plan.md § Implementation Steps 11). Dismissible ("Để sau")
  // without blocking the user from moving on — the numbered placeholder
  // stays until they confirm later via Settings/meeting detail (P7).
  const unresolvedSpeakers: UnresolvedSpeaker[] = (status?.result?.speakers ?? [])
    .filter((s) => s.resolved === false)
    .map((s) => ({ speakerId: s.speakerId, totalSpeakSec: s.totalSpeakSec, displayName: s.displayName, confidence: s.confidence }));
  const showResolveModal = status?.status === 'completed' && unresolvedSpeakers.length > 0 && !resolveModalDismissed;

  useEffect(() => {
    // Deliberately depends only on `status?.status` (not `loadCompletedMeeting`, which closes over stable
    // `app`/`meetingId`) — the guard ref already makes this run-once, but a wider dependency array would
    // otherwise refetch every 3s poll tick while still `completed`.
    if (status?.status !== 'completed' || saveModalOpenedRef.current) return;
    saveModalOpenedRef.current = true;
    void loadCompletedMeeting();
    setShowSaveModal(true);
  }, [status?.status]);

  return (
    <div className="ma-processing">
      <h2 className="ma-processing__title">{t('processing.title')}</h2>
      <p className="ma-processing__provider">{t('processing.provider', { provider: status?.provider ?? '…' })}</p>

      <ol className="ma-processing__steps">
        {STEPS.map((step, index) => {
          const state = stepState(index, status);
          const iconName = state === 'done' ? 'checkmark-circle' : state === 'failed' ? 'alert-circle' : 'clock';
          return (
            <li key={step} className={`ma-processing__step ma-processing__step--${state}`}>
              <Icon name={iconName} size={18} />
              <span>{t(`processing.step.${step}`)}</span>
            </li>
          );
        })}
      </ol>

      <p className="ma-processing__elapsed">{t('processing.elapsed', { sec: elapsedSec })}</p>

      {showRetry ? (
        <div className="ma-processing__alert" role="alert">
          <p>{status?.stale ? t('processing.stale') : (status?.error ?? t('processing.failed'))}</p>
          <button type="button" className="ma-processing__retry" onClick={() => void retry()}>
            {t('processing.retry')}
          </button>
        </div>
      ) : null}

      {status?.status === 'completed' && completedMeeting ? (
        <div className="ma-processing__completed">
          <SummaryCard
            roomId={context.roomId}
            meetingId={completedMeeting._id}
            summaryText={completedMeeting.summaryText}
            keyTopics={completedMeeting.keyTopics}
            summaryError={completedMeeting.summaryError}
            onRegenerated={() => void loadCompletedMeeting()}
          />
          <ActionItemsCard
            roomId={context.roomId}
            meetingTitle={completedMeeting.title ?? ''}
            items={completedActionItems}
            onChanged={() => void loadCompletedMeeting()}
          />
          <div className="ma-processing__completed-actions">
            <SendToChatButton
              roomId={context.roomId}
              meetingId={completedMeeting._id}
              hasSummary={Boolean(completedMeeting.summaryText)}
              sentToChatAt={completedMeeting.sentToChatAt}
              onSent={() => void loadCompletedMeeting()}
            />
            <button type="button" onClick={() => onOpenMeeting(completedMeeting._id)}>
              {t('processing.openDetail')}
            </button>
          </div>
        </div>
      ) : null}

      <button type="button" className="ma-processing__done" onClick={onDone}>
        {t('processing.backToHistory')}
      </button>

      {showSaveModal && completedMeeting ? (
        <SaveToFilesModal
          title={completedMeeting.title ?? ''}
          meetingId={completedMeeting._id}
          startedAt={completedMeeting.startedAt}
          folderId={completedMeeting.folderId}
          artifacts={SAVE_TO_FILES_ARTIFACTS.map((a) => ({ labelKey: a.labelKey, fileId: completedMeeting[a.key] as string | undefined }))}
          onClose={() => setShowSaveModal(false)}
        />
      ) : null}

      {showResolveModal && meetingId && context.roomId ? (
        <ResolveSpeakersModal
          roomId={context.roomId}
          meetingId={meetingId}
          speakers={unresolvedSpeakers}
          onClose={() => setResolveModalDismissed(true)}
          onResolved={() => setResolveModalDismissed(true)}
        />
      ) : null}
    </div>
  );
}
