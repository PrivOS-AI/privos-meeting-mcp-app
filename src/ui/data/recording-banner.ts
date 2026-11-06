/**
 * Which recording banner the app shows above every screen (`recovery-banner.tsx`):
 *
 *  1. a meeting recorded from the Room's shared browser that is running now —
 *     to everyone in the room, whoever started it (often the Room's agent,
 *     whose bot owns it): its owner may watch it live and end it, the room's
 *     owners and moderators may stop it;
 *  2. one that stopped by itself within the last hour (`captureEndReason`:
 *     the longest allowed time, a long silence, or the Room browser never
 *     reached), until dismissed;
 *  3. the viewer's own recording left unfinished (tab closed mid-recording,
 *     or marked `interrupted`): finish or cancel it.
 *
 * Pure, so the choice is tested without a host.
 */
import type { ActiveRecordingMeeting } from './meeting-draft-repository.js';

/** How long a "stopped by itself" notice stays up. */
export const ENDED_NOTICE_MS = 60 * 60_000;

export type RecordingBannerChoice =
  | { kind: 'browser-live'; meeting: ActiveRecordingMeeting; isOwner: boolean }
  | { kind: 'browser-ended'; meeting: ActiveRecordingMeeting }
  | { kind: 'recover'; meeting: ActiveRecordingMeeting }
  | null;

export interface RecordingBannerInput {
  /** The viewer's own meetings left in `recording`/`interrupted`. */
  own: readonly ActiveRecordingMeeting[];
  /** The room's latest Room-browser meetings, whoever owns them. */
  roomBrowser: readonly ActiveRecordingMeeting[];
  userId: string;
  /** Notices the viewer closed. */
  dismissed: ReadonlySet<string>;
  now: number;
  /** The meeting this tab already shows live: nothing to announce about it. */
  showingMeetingId?: string | null;
}

function isLiveBrowser(meeting: ActiveRecordingMeeting): boolean {
  return meeting.captureSource === 'browser' && meeting.status === 'recording' && !meeting.endedAt;
}

export function pickRecordingBanner(input: RecordingBannerInput): RecordingBannerChoice {
  const { own, roomBrowser, userId, dismissed, now, showingMeetingId } = input;
  const live = roomBrowser.find((m) => isLiveBrowser(m) && m._id !== showingMeetingId);
  if (live) return { kind: 'browser-live', meeting: live, isOwner: live.ownerUserId === userId };

  const ended = roomBrowser.find((m) => {
    if (!m.captureEndReason || !m.endedAt || dismissed.has(m._id)) return false;
    const at = Date.parse(m.endedAt);
    return Number.isFinite(at) && now - at <= ENDED_NOTICE_MS;
  });
  if (ended) return { kind: 'browser-ended', meeting: ended };

  const stuck = own.find((m) => !isLiveBrowser(m) && m._id !== showingMeetingId);
  return stuck ? { kind: 'recover', meeting: stuck } : null;
}
