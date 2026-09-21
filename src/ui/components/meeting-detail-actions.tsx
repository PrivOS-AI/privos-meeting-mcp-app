/**
 * Meeting detail's action-button row (phase-07 § Requirements: bookmark
 * here, Export SRT/DOCX, Save to Files, Share, Send to Chat). Split out of
 * `meeting-detail-screen.tsx` to keep that screen under the repo's
 * ~200-line convention — purely presentational, all behavior stays in the
 * container as callback props.
 */
import { useI18n } from '../i18n/i18n-provider.js';
import { Icon } from './icon.js';
import { SendToChatButton } from './send-to-chat-button.js';

export interface MeetingDetailActionsProps {
  roomId: string;
  meetingId: string;
  canBookmark: boolean;
  canShare: boolean;
  hasSummary: boolean;
  sentToChatAt?: string;
  onBookmarkHere(): void;
  onExportSrt(): void;
  onExportDocx(): void;
  onSaveToFiles(): void;
  onShare(): void;
  onSentToChat(): void;
}

export function MeetingDetailActions({
  roomId,
  meetingId,
  canBookmark,
  canShare,
  hasSummary,
  sentToChatAt,
  onBookmarkHere,
  onExportSrt,
  onExportDocx,
  onSaveToFiles,
  onShare,
  onSentToChat,
}: MeetingDetailActionsProps) {
  const { t } = useI18n();
  return (
    <div className="ma-meeting-detail__toolbar-row">
      <button type="button" onClick={onBookmarkHere} disabled={!canBookmark}>
        <Icon name="bookmark-add" size={14} /> {t('recording.bookmark.add')}
      </button>
      <button type="button" onClick={onExportSrt}>
        <Icon name="arrow-download" size={14} /> {t('history.rowMenu.exportSrt')}
      </button>
      <button type="button" onClick={onExportDocx}>
        <Icon name="arrow-export" size={14} /> {t('history.rowMenu.exportDocx')}
      </button>
      <button type="button" onClick={onSaveToFiles}>
        {t('detail.saveToFiles')}
      </button>
      <button type="button" onClick={onShare} disabled={!canShare}>
        <Icon name="share" size={14} /> {t('detail.share')}
      </button>
      <SendToChatButton roomId={roomId} meetingId={meetingId} hasSummary={hasSummary} sentToChatAt={sentToChatAt} onSent={onSentToChat} />
    </div>
  );
}
