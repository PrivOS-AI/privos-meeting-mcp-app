/**
 * Ends a meeting recorded from the Room's shared browser after its listener
 * stopped by itself (`browser-audio-listener.ts`: the longest allowed
 * recording, a stretch without sound, or the Room browser's audio not reached):
 * the row is closed and processing starts, as `meeting_listen_stop` would. The
 * reason is kept on the row (`captureEndReason`) for the room's banner and the
 * agent's `meeting_listen_status`. A recording that stopped without a single
 * saved part is marked `failed` with the reason instead of left half-made.
 *
 * Runs on this server with no caller: the listener was started by an
 * authorized caller, and only the meeting it was started for is touched.
 */
import type { BrowserAudioEndReason, BrowserAudioStatus } from '../browser-audio/browser-audio-listener.js';
import { env } from '../env.js';
import type { AppDbBotClient } from '../hub/app-db-bot-client.js';
import { AppError } from '../../shared/app-error.js';
import { startMeetingProcessing } from './process-tool.js';
import type { ToolRuntime } from './registry.js';

/** What the room is told when a Room-browser recording stopped by itself. */
export function autoStopMessage(reason: BrowserAudioEndReason): string {
  if (reason === 'max_duration') return `The recording stopped by itself after the longest allowed time (${env.browserRecordingMaxMin} minutes).`;
  if (reason === 'silence') return `The recording stopped by itself after ${env.browserRecordingSilenceStopMin} minutes without sound.`;
  return "The Room's browser audio could not be reached.";
}

/** The `onAutoStop` a listener for this meeting is started with. */
export function endOnAutoStop(db: AppDbBotClient, runtime: ToolRuntime, roomId: string, meetingId: string) {
  return async (reason: BrowserAudioEndReason, heard: BrowserAudioStatus): Promise<void> => {
    const meeting = await db.getById('meetings', 'room', meetingId);
    // Ended another way meanwhile (a Stop, the tab's End, deleted): nothing to do.
    if (!meeting || meeting.roomId !== roomId || meeting.status !== 'recording') return;
    const endedAt = new Date().toISOString();
    const durationSec = Math.round(heard.heardSec);
    const fail = async (message: string) => {
      await db.update('meetings', 'room', meetingId, { endedAt, durationSec, status: 'failed', summaryError: message.slice(0, 4000) });
      console.warn(`[browser-audio] meeting=${meetingId} ended as failed (${reason}): ${message}`);
    };
    // Its own write: a Hub that has not reconciled the schema yet must not block closing the meeting.
    const keepReason = () => db.update('meetings', 'room', meetingId, { captureEndReason: reason }).catch(() => undefined);

    if (heard.partsUploaded === 0) {
      await fail(autoStopMessage(reason));
      await keepReason();
      return;
    }
    await db.update('meetings', 'room', meetingId, { endedAt, durationSec, status: 'uploading' });
    await keepReason();
    try {
      await startMeetingProcessing(db, runtime, roomId, meetingId, meeting);
    } catch (error) {
      await fail(error instanceof AppError ? error.message : `${autoStopMessage(reason)} Processing could not start.`);
      if (!(error instanceof AppError)) throw error;
    }
  };
}
