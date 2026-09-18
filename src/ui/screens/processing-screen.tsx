/**
 * Screen 1f — "Đang xử lý": polls `meeting_status` every 3s while the
 * background job concats parts, transcribes, segments and writes the
 * transcript. The 8 steps mirror `JobStep` in `src/server/jobs/job-repository.ts`
 * 1:1 so this screen never silently drifts from the backend's step enum.
 */
import { useEffect, useRef, useState } from 'react';
import { parseToolResult, usePrivosApp, usePrivosContext } from '@privos_ai/app-react';

import { Icon } from '../components/icon.js';
import { useI18n } from '../i18n/i18n-provider.js';
import { useRecordingState } from '../stores/recording-store.js';

export interface ProcessingScreenProps {
  onDone(): void;
}

const STEPS = ['download', 'decode', 'transcribe', 'segment', 'embed', 'summarize', 'write', 'cleanup'] as const;
type Step = (typeof STEPS)[number];

interface MeetingStatusResult {
  status: 'queued' | 'processing' | 'completed' | 'failed' | 'not_found';
  step: Step | null;
  progress: number;
  heartbeatAt: string | null;
  stale: boolean;
  provider?: string;
  error?: string;
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

export function ProcessingScreen({ onDone }: ProcessingScreenProps) {
  const { t } = useI18n();
  const app = usePrivosApp();
  const context = usePrivosContext();
  const recording = useRecordingState();
  const meetingId = recording.meetingId;

  const [status, setStatus] = useState<MeetingStatusResult | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);
  const startedAtRef = useRef(Date.now());

  useEffect(() => {
    if (!meetingId) return undefined;
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

      <button type="button" className="ma-processing__done" onClick={onDone}>
        {t('processing.backToHistory')}
      </button>
    </div>
  );
}
