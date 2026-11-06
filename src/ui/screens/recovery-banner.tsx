/**
 * The recording banner above every screen; which one shows is decided in
 * `data/recording-banner.ts`:
 *
 *  - A meeting recorded from the Room's shared browser (`captureSource:
 *    'browser'`, often started by the Room's agent, whose bot then owns it) is
 *    shown to everyone in the room while it runs, with how long it has run. Its
 *    owner may watch it live or end it; the room's owners and moderators may
 *    stop it (`meeting_listen_stop` checks that again). Stopping shows
 *    stopping → stopped (processing starts), or the reason it failed with a
 *    retry.
 *  - One that stopped by itself (longest allowed time, a long silence, the
 *    Room browser not reached) is announced for an hour, until dismissed.
 *  - The viewer's own recording stuck in `recording`/`interrupted` with no
 *    `endedAt` (tab crash, browser closed mid recording) can be finished from
 *    the parts already uploaded, or cancelled outright.
 */
import { useCallback, useEffect, useState } from 'react';
import { parseToolResult, usePrivosApp, usePrivosContext } from '@privos_ai/app-react';

import { formatClock } from '../data/format-time.js';
import { listActiveRecordingMeetings, listRoomBrowserRecordings, updateRecordingMeeting, type ActiveRecordingMeeting } from '../data/meeting-draft-repository.js';
import { listParts } from '../data/meeting-part-upload.js';
import { pickRecordingBanner } from '../data/recording-banner.js';
import { parseToolResultOrThrow } from '../data/tool-error.js';
import { useI18n } from '../i18n/i18n-provider.js';
import { Icon } from '../components/icon.js';
import { useCanManageRoomSettings } from './settings/use-can-manage-room-settings.js';
import { useRecordingState, useRecordingStore } from '../stores/recording-store.js';

const RELOAD_MS = 30_000;
const END_REASONS = new Set(['max_duration', 'silence', 'unreachable']);

type StopNotice = { meeting: ActiveRecordingMeeting; phase: 'stopping' | 'stopped' | 'failed'; error?: string };

export function RecoveryBanner({ onWatchLive }: { onWatchLive(): void }) {
  const app = usePrivosApp();
  const context = usePrivosContext();
  const { t } = useI18n();
  const recording = useRecordingState();
  const [own, setOwn] = useState<ActiveRecordingMeeting[]>([]);
  const [roomBrowser, setRoomBrowser] = useState<ActiveRecordingMeeting[]>([]);
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  const [stopNotice, setStopNotice] = useState<StopNotice | null>(null);

  const load = useCallback(async () => {
    if (!context.roomId || !context.userId) return;
    const [mine, browser] = await Promise.all([
      listActiveRecordingMeetings(app, context.roomId, context.userId).catch(() => null),
      listRoomBrowserRecordings(app, context.roomId).catch(() => null),
    ]);
    if (mine) setOwn(mine);
    if (browser) setRoomBrowser(browser);
  }, [app, context.roomId, context.userId]);

  useEffect(() => {
    let cancelled = false;
    const run = () => {
      if (!cancelled) void load();
    };
    run();
    // The Room's agent may start a recording, or one may stop by itself, while the app is open.
    const timer = setInterval(run, RELOAD_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [load]);

  const dismiss = (meetingId: string) => setDismissed((prev) => new Set(prev).add(meetingId));

  async function stop(meeting: ActiveRecordingMeeting): Promise<void> {
    setStopNotice({ meeting, phase: 'stopping' });
    try {
      parseToolResultOrThrow(await app.callServerTool({ name: 'meeting_listen_stop', arguments: { roomId: context.roomId, meetingId: meeting._id } }));
      setStopNotice({ meeting, phase: 'stopped' });
      dismiss(meeting._id); // this notice says it stopped; no second one once the reload sees it ended
      void load();
    } catch (error) {
      setStopNotice({ meeting, phase: 'failed', error: error instanceof Error ? error.message : String(error) });
    }
  }

  if (stopNotice) {
    const { meeting, phase } = stopNotice;
    const title = meeting.title || t('screen.new.untitled');
    return (
      <div className={`ma-banner ma-banner--recovery${phase === 'failed' ? ' ma-banner--failed' : ''}`} role="status" aria-live="polite">
        <span className="ma-banner__icon">
          <Icon name={phase === 'failed' ? 'alert-circle' : phase === 'stopped' ? 'checkmark-circle' : 'globe'} size={18} />
        </span>
        <span className="ma-banner__body">
          {phase === 'stopping'
            ? t('recovery.browser.message', { title })
            : phase === 'stopped'
              ? t('recovery.browser.stopped', { title })
              : t('recovery.browser.stopFailed', { title, error: stopNotice.error ?? '' })}
        </span>
        <div className="ma-banner__actions">
          {phase === 'stopping' ? (
            <button type="button" className="ma-banner__action" disabled>
              {t('recovery.browser.stopping')}
            </button>
          ) : null}
          {phase === 'failed' ? (
            <button type="button" className="ma-banner__action ma-banner__action--primary" onClick={() => void stop(meeting)}>
              {t('recovery.browser.retry')}
            </button>
          ) : null}
        </div>
        {phase !== 'stopping' ? (
          <button type="button" className="ma-banner__dismiss" aria-label={t('banner.dismiss')} onClick={() => setStopNotice(null)}>
            <Icon name="close" size={14} />
          </button>
        ) : null}
      </div>
    );
  }

  const choice = pickRecordingBanner({ own, roomBrowser, userId: context.userId, dismissed, now: Date.now(), showingMeetingId: recording.meetingId });
  if (!choice) return null;
  if (choice.kind === 'browser-live') {
    return <LiveBrowserBanner key={choice.meeting._id} meeting={choice.meeting} isOwner={choice.isOwner} onWatchLive={onWatchLive} onStop={stop} />;
  }
  if (choice.kind === 'browser-ended') {
    return <EndedBrowserBanner meeting={choice.meeting} onDismiss={() => dismiss(choice.meeting._id)} />;
  }
  return <UnfinishedRecordingBanner key={choice.meeting._id} meeting={choice.meeting} onDone={() => void load()} />;
}

/** A Room-browser recording running now: how long, and what this viewer may do about it. */
function LiveBrowserBanner({ meeting, isOwner, onWatchLive, onStop }: { meeting: ActiveRecordingMeeting; isOwner: boolean; onWatchLive(): void; onStop(meeting: ActiveRecordingMeeting): Promise<void> }) {
  const { t } = useI18n();
  const store = useRecordingStore();
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  const startedAt = meeting.startedAt ? Date.parse(meeting.startedAt) : NaN;
  const elapsed = Number.isFinite(startedAt) ? formatClock((now - startedAt) / 1000) : null;

  async function watch(): Promise<void> {
    setBusy(true);
    try {
      await store.resumeBrowserRecording(meeting);
      onWatchLive();
    } catch {
      setBusy(false);
    }
  }

  return (
    <div className="ma-banner ma-banner--recovery" role="status" aria-live="polite">
      <span className="ma-banner__icon">
        <Icon name="globe" size={18} />
      </span>
      <span className="ma-banner__body">
        {t('recovery.browser.message', { title: meeting.title || t('screen.new.untitled') })}
        {elapsed ? <span className="ma-banner__meta">{elapsed}</span> : null}
      </span>
      {isOwner ? (
        <div className="ma-banner__actions">
          <button type="button" className="ma-banner__action ma-banner__action--primary" disabled={busy} onClick={() => void watch()}>
            {t('recovery.browser.watch')}
          </button>
          <button type="button" className="ma-banner__action" disabled={busy} onClick={() => void onStop(meeting)}>
            {t('recovery.browser.end')}
          </button>
        </div>
      ) : (
        <RoomManagerStop meeting={meeting} onStop={onStop} />
      )}
    </div>
  );
}

/** Stop, for the room's owners and moderators only (asked of the server once such a banner shows). */
function RoomManagerStop({ meeting, onStop }: { meeting: ActiveRecordingMeeting; onStop(meeting: ActiveRecordingMeeting): Promise<void> }) {
  const { t } = useI18n();
  const { canManage } = useCanManageRoomSettings();
  if (!canManage) return null;
  return (
    <div className="ma-banner__actions">
      <button type="button" className="ma-banner__action" onClick={() => void onStop(meeting)}>
        {t('recovery.browser.stop')}
      </button>
    </div>
  );
}

/** A Room-browser recording that stopped by itself: why, and whether anything was saved. */
function EndedBrowserBanner({ meeting, onDismiss }: { meeting: ActiveRecordingMeeting; onDismiss(): void }) {
  const { t } = useI18n();
  const reason = END_REASONS.has(meeting.captureEndReason ?? '') ? meeting.captureEndReason : 'unreachable';
  const failed = meeting.status === 'failed';
  return (
    <div className={`ma-banner ma-banner--recovery${failed ? ' ma-banner--failed' : ''}`} role="status" aria-live="polite">
      <span className="ma-banner__icon">
        <Icon name={failed ? 'alert-circle' : 'globe'} size={18} />
      </span>
      <span className="ma-banner__body">
        {t(`recovery.browser.ended.${reason}`, { title: meeting.title || t('screen.new.untitled') })}{' '}
        {t(failed ? 'recovery.browser.ended.nothing' : 'recovery.browser.ended.processing')}
      </span>
      <button type="button" className="ma-banner__dismiss" aria-label={t('banner.dismiss')} onClick={onDismiss}>
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}

/** The viewer's own recording left unfinished: finish it from the parts already uploaded, or cancel it. */
function UnfinishedRecordingBanner({ meeting, onDone }: { meeting: ActiveRecordingMeeting; onDone(): void }) {
  const app = usePrivosApp();
  const context = usePrivosContext();
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  async function finishAndProcess(): Promise<void> {
    setBusy(true);
    try {
      await updateRecordingMeeting(app, meeting._id, {
        endedAt: new Date().toISOString(),
        status: 'uploading',
      });
      const raw = await app.callServerTool({ name: 'meeting_process', arguments: { roomId: context.roomId, meetingId: meeting._id } });
      parseToolResult(raw);
      setDone(true);
      onDone();
    } catch {
      setBusy(false);
    }
  }

  async function cancelRecording(): Promise<void> {
    setBusy(true);
    try {
      if (meeting.folderId) {
        const parts = await listParts(app, context.roomId, meeting.folderId).catch(() => []);
        for (const part of parts) {
          await app.rest({ method: 'DELETE', path: `file-management.files/${part._id}` }).catch(() => undefined);
        }
      }
      await updateRecordingMeeting(app, meeting._id, { status: 'failed' });
      setDone(true);
      onDone();
    } catch {
      setBusy(false);
    }
  }

  if (done) return null;
  return (
    <div className="ma-banner ma-banner--recovery" role="status" aria-live="polite">
      <span className="ma-banner__icon">
        <Icon name="record" size={18} />
      </span>
      <span className="ma-banner__body">{t('recovery.banner.message', { count: meeting.partCount ?? 0 })}</span>
      <div className="ma-banner__actions">
        <button type="button" className="ma-banner__action ma-banner__action--primary" disabled={busy} onClick={() => void finishAndProcess()}>
          {t('recovery.banner.finish')}
        </button>
        <button type="button" className="ma-banner__action" disabled={busy} onClick={() => void cancelRecording()}>
          {t('recovery.banner.cancel')}
        </button>
      </div>
    </div>
  );
}
