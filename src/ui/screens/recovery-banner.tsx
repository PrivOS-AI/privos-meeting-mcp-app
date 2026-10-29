/**
 * On mount, looks for a meeting owned by the current user that is stuck in
 * `recording`/`interrupted` with no `endedAt` (tab crash, browser close mid
 * recording) and offers to finish it from the parts already uploaded, or
 * cancel it outright.
 *
 * A meeting recorded from the Room's shared browser (`captureSource: 'browser'`,
 * often started by the Room's agent) is not stuck: the server is recording it.
 * For that one the banner offers to watch it live or to end it.
 */
import { useEffect, useState } from 'react';
import { parseToolResult, usePrivosApp, usePrivosContext } from '@privos_ai/app-react';

import { listActiveRecordingMeetings, updateRecordingMeeting, type ActiveRecordingMeeting } from '../data/meeting-draft-repository.js';
import { listParts } from '../data/meeting-part-upload.js';
import { useI18n } from '../i18n/i18n-provider.js';
import { Icon } from '../components/icon.js';
import { useRecordingState, useRecordingStore } from '../stores/recording-store.js';

export function RecoveryBanner({ onWatchLive }: { onWatchLive(): void }) {
  const app = usePrivosApp();
  const context = usePrivosContext();
  const { t } = useI18n();
  const store = useRecordingStore();
  const recording = useRecordingState();
  const [meeting, setMeeting] = useState<ActiveRecordingMeeting | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!context.roomId || !context.userId) return;
    const load = () =>
      listActiveRecordingMeetings(app, context.roomId, context.userId)
        .then((meetings) => {
          // A live Room-browser recording first: it is the one someone may want to watch.
          if (!cancelled) setMeeting(meetings.find((m) => m.captureSource === 'browser' && m.status === 'recording') ?? meetings[0] ?? null);
        })
        .catch(() => undefined);
    void load();
    // The Room's agent may start a recording while the app is open.
    const timer = setInterval(() => void load(), 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [app, context.roomId, context.userId]);

  // Already on screen in this tab: nothing to recover.
  if (!meeting || recording.meetingId === meeting._id) return null;

  if (meeting.captureSource === 'browser' && meeting.status === 'recording') {
    const live = meeting;
    const watch = async (): Promise<void> => {
      setBusy(true);
      try {
        await store.resumeBrowserRecording(live);
        onWatchLive();
      } catch {
        setBusy(false);
      }
    };
    const end = async (): Promise<void> => {
      setBusy(true);
      try {
        parseToolResult(await app.callServerTool({ name: 'meeting_listen_stop', arguments: { roomId: context.roomId, meetingId: live._id } }));
        setMeeting(null);
      } catch {
        setBusy(false);
      }
    };
    return (
      <div className="ma-banner ma-banner--recovery" role="status" aria-live="polite">
        <span className="ma-banner__icon">
          <Icon name="globe" size={18} />
        </span>
        <span className="ma-banner__body">{t('recovery.browser.message', { title: live.title || t('screen.new.untitled') })}</span>
        <div className="ma-banner__actions">
          <button type="button" className="ma-banner__action ma-banner__action--primary" disabled={busy} onClick={() => void watch()}>
            {t('recovery.browser.watch')}
          </button>
          <button type="button" className="ma-banner__action" disabled={busy} onClick={() => void end()}>
            {t('recovery.browser.end')}
          </button>
        </div>
      </div>
    );
  }

  async function finishAndProcess(): Promise<void> {
    if (!meeting) return;
    setBusy(true);
    try {
      await updateRecordingMeeting(app, meeting._id, {
        endedAt: new Date().toISOString(),
        status: 'uploading',
      });
      const raw = await app.callServerTool({ name: 'meeting_process', arguments: { roomId: context.roomId, meetingId: meeting._id } });
      parseToolResult(raw);
      setMeeting(null);
    } catch {
      setBusy(false);
    }
  }

  async function cancelRecording(): Promise<void> {
    if (!meeting) return;
    setBusy(true);
    try {
      if (meeting.folderId) {
        const parts = await listParts(app, context.roomId, meeting.folderId).catch(() => []);
        for (const part of parts) {
          await app.rest({ method: 'DELETE', path: `file-management.files/${part._id}` }).catch(() => undefined);
        }
      }
      await updateRecordingMeeting(app, meeting._id, { status: 'failed' });
      setMeeting(null);
    } catch {
      setBusy(false);
    }
  }

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
