/**
 * The live "Summary" panel (item #5): while a meeting is running it asks the
 * `meeting_live_summary` tool to summarize the transcript SO FAR, every ~10
 * minutes (plus a manual refresh), and renders the summary with the action
 * items stacked directly beneath it. The authoritative, stored summary is
 * still produced once from the final transcript after the meeting ends.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { usePrivosApp, usePrivosContext } from '@privos_ai/app-react';

import { fetchLiveSummary, type LiveSummaryResult, type LiveSummaryLine } from '../data/live-summary-api.js';
import { useI18n } from '../i18n/i18n-provider.js';
import { asLanguageCode } from '../../shared/languages.js';
import { resolveLineSpeakerKey, useRecordingState, type RecordingState } from '../stores/recording-store.js';

/** Auto-refresh cadence — the first summary lands ~10 min in, then every 10 min. */
const REFRESH_INTERVAL_MS = 10 * 60_000;
/** Below this many finalized lines there is nothing worth summarizing yet. */
const MIN_LINES = 3;

type Status = 'idle' | 'loading' | 'ready' | 'error';

/** Finalized caption lines -> the summarizer's line payload, with each line's effective (corrected) speaker name. */
function buildSegments(state: RecordingState, speakerName: (key: string | undefined) => string): LiveSummaryLine[] {
  const out: LiveSummaryLine[] = [];
  for (const line of state.lines) {
    if (!line.isFinal) continue;
    const text = line.text.trim();
    if (!text) continue;
    const key = resolveLineSpeakerKey(state, line);
    out.push({ speakerId: key ?? 'unknown', speakerName: speakerName(key), startSec: Math.round(line.atSec), text });
  }
  return out;
}

export function LiveSummaryPanel() {
  const app = usePrivosApp();
  const { roomId } = usePrivosContext();
  const { t, language } = useI18n();
  const state = useRecordingState();

  const [result, setResult] = useState<LiveSummaryResult | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);

  // The interval + refresh handler read the LATEST state without re-subscribing.
  const stateRef = useRef(state);
  stateRef.current = state;
  const runningRef = useRef(false);
  const resultRef = useRef<LiveSummaryResult | null>(result);
  resultRef.current = result;

  const run = useCallback(async () => {
    if (runningRef.current) return;
    const current = stateRef.current;
    if (!current.meetingId) return;
    const speakerKeys = Object.keys(current.speakerMap);
    const speakerName = (key: string | undefined): string => {
      if (!key) return t('recording.speakerBadge.speaking');
      return current.speakerMap[key]?.displayName ?? t('recording.speakerBadge.numbered', { n: speakerKeys.indexOf(key) + 1 });
    };
    const segments = buildSegments(current, speakerName);
    if (segments.length < MIN_LINES) return;

    runningRef.current = true;
    setStatus('loading');
    try {
      const next = await fetchLiveSummary(app, {
        roomId,
        meetingId: current.meetingId,
        title: current.title,
        language: asLanguageCode(language),
        segments,
      });
      setResult(next);
      setUpdatedAt(Date.now());
      setStatus('ready');
    } catch {
      // Keep the last good summary visible if we have one; only surface the error state on a first failure.
      setStatus(resultRef.current ? 'ready' : 'error');
    } finally {
      runningRef.current = false;
    }
  }, [app, roomId, language, t]);

  // Keep `run` in a ref so the 10-min interval is created ONCE per status change.
  // (The panel re-renders every second as the elapsed clock ticks; depending on
  // `run` here would clear+recreate the timer each render and it would never fire.)
  const runRef = useRef(run);
  runRef.current = run;
  useEffect(() => {
    if (state.status !== 'recording' && state.status !== 'paused') return;
    const id = setInterval(() => void runRef.current(), REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [state.status]);

  const busy = status === 'loading';
  const timeLabel = updatedAt
    ? new Date(updatedAt).toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit' })
    : null;

  return (
    <div className="ma-live-summary">
      <section className="ma-live-summary__section">
        <h3 className="ma-side-panel__section-title">{t('recording.side.summary')}</h3>
        {result ? (
          <p className="ma-live-summary__text">{result.summary}</p>
        ) : (
          <p className="ma-side-panel__empty">
            {status === 'loading'
              ? t('recording.liveSummary.loading')
              : status === 'error'
                ? t('recording.liveSummary.error')
                : t('recording.liveSummary.waiting')}
          </p>
        )}
      </section>

      <section className="ma-live-summary__section">
        <h3 className="ma-side-panel__section-title">{t('recording.side.actions')}</h3>
        {result && result.action_items.length > 0 ? (
          <ul className="ma-live-summary__actions">
            {result.action_items.map((item, i) => (
              <li key={i} className="ma-live-summary__action">
                <span className="ma-live-summary__action-task">{item.task}</span>
                {item.owner || item.due ? (
                  <span className="ma-live-summary__action-meta">{[item.owner, item.due].filter(Boolean).join(' · ')}</span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="ma-side-panel__empty">{result ? t('recording.liveSummary.noActions') : t('recording.liveSummary.waiting')}</p>
        )}
      </section>

      <div className="ma-live-summary__footer">
        {status === 'error' && result ? <span className="ma-live-summary__status">{t('recording.liveSummary.error')}</span> : null}
        {timeLabel ? <span className="ma-live-summary__status">{t('recording.liveSummary.updatedAt', { time: timeLabel })}</span> : null}
        <button type="button" className="ma-live-summary__refresh" onClick={() => void run()} disabled={busy}>
          {busy ? t('recording.liveSummary.loading') : t('recording.liveSummary.refresh')}
        </button>
      </div>
    </div>
  );
}
