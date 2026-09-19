/**
 * One row of the history table (phase-07 § Requirements: "title + date,
 * speaker avatar, duration (mono), action count, status badge, ⋯
 * menu"). Split out of `history-screen.tsx` to keep that screen under the
 * repo's ~200-line convention.
 */
import type { MeetingReadModel, MeetingSpeakerSummary } from '../data/meeting-read-model.js';
import { formatClock } from '../data/format-time.js';
import { useI18n } from '../i18n/i18n-provider.js';
import { MeetingRowMenu } from './meeting-row-menu.js';
import { SpeakerAvatar } from './speaker-avatar.js';
import { StatusBadge } from './status-badge.js';

const MAX_AVATARS = 3;

export interface MeetingHistoryRowProps {
  meeting: MeetingReadModel;
  speakers: MeetingSpeakerSummary[];
  actionItemCount: number;
  isOwner: boolean;
  onOpen(): void;
  onRename(): void;
  onExportSrt(): void;
  onExportDocx(): void;
  onDelete(): void;
}

export function MeetingHistoryRow({ meeting, speakers, actionItemCount, isOwner, onOpen, onRename, onExportSrt, onExportDocx, onDelete }: MeetingHistoryRowProps) {
  const { t } = useI18n();
  const shown = speakers.slice(0, MAX_AVATARS);
  const overflow = speakers.length - shown.length;
  const date = meeting.startedAt ? new Date(meeting.startedAt).toLocaleDateString() : '—';

  return (
    <tr className="ma-history-row">
      <td className="ma-history-row__title" onClick={onOpen}>
        <span className="ma-history-row__title-text">{meeting.title || t('screen.new.untitled')}</span>
        <span className="ma-history-row__date">{date}</span>
      </td>
      <td>
        <div className="ma-history-row__avatars">
          {shown.map((speaker) => (
            <SpeakerAvatar key={speaker.speakerId} name={speaker.displayName} colorKey={speaker.colorKey} size={24} />
          ))}
          {overflow > 0 ? <span className="ma-history-row__avatar-overflow">+{overflow}</span> : null}
        </div>
      </td>
      <td className="ma-history-row__duration">{formatClock(meeting.durationSec ?? 0)}</td>
      <td className="ma-history-row__actions-count">{actionItemCount}</td>
      <td>
        <StatusBadge status={meeting.status} />
      </td>
      <td className="ma-history-row__menu">
        <MeetingRowMenu canDelete={isOwner} onOpen={onOpen} onRename={onRename} onExportSrt={onExportSrt} onExportDocx={onExportDocx} onDelete={onDelete} />
      </td>
    </tr>
  );
}
