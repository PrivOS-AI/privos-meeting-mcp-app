/**
 * On mount, looks for a meeting owned by the current user that is stuck in
 * `recording`/`interrupted` with no `endedAt` (tab crash, browser close mid
 * recording) and offers to finish it from the parts already uploaded, or
 * cancel it outright.
 */
import { useEffect, useState } from 'react';
import { parseToolResult, usePrivosApp, usePrivosContext } from '@privos_ai/app-react';

import { listActiveRecordingMeetings, updateRecordingMeeting, type ActiveRecordingMeeting } from '../data/meeting-draft-repository.js';
import { listParts } from '../data/meeting-part-upload.js';
import { useI18n } from '../i18n/i18n-provider.js';
import { Icon } from '../components/icon.js';

export function RecoveryBanner() {
  const app = usePrivosApp();
  const context = usePrivosContext();
  const { t } = useI18n();
  const [meeting, setMeeting] = useState<ActiveRecordingMeeting | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!context.roomId || !context.userId) return;
    listActiveRecordingMeetings(app, context.roomId, context.userId)
      .then((meetings) => {
        if (!cancelled) setMeeting(meetings[0] ?? null);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [app, context.roomId, context.userId]);

  if (!meeting) return null;

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
