/**
 * One caption row in the light "Transcript" view (1a): speaker badge, text
 * (+ inline translation when present), mm:ss, bookmark button.
 */
import type { CaptionLine as CaptionLineData, LiveSpeakerBadge } from '../stores/recording-store.js';
import { useI18n } from '../i18n/i18n-provider.js';
import { Icon } from './icon.js';

export interface CaptionLineProps {
  line: CaptionLineData;
  speaker?: LiveSpeakerBadge;
  speakerIndex: number;
  onBookmark?: () => void;
}

function formatTimestamp(atSec: number): string {
  const minutes = Math.floor(atSec / 60);
  const seconds = Math.floor(atSec % 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function CaptionLine({ line, speaker, speakerIndex, onBookmark }: CaptionLineProps) {
  const { t } = useI18n();
  const badgeLabel = speaker?.displayName ?? (line.speakerKey ? t('recording.speakerBadge.numbered', { n: speakerIndex }) : t('recording.speakerBadge.speaking'));

  return (
    <div className={`ma-caption-line${line.isFinal ? '' : ' ma-caption-line--draft'}`}>
      {line.speakerKey ? (
        <span className={`ma-caption-line__avatar ma-caption-line__avatar--${speaker?.colorKey ?? 'blue'}`} aria-hidden="true">
          {badgeLabel.charAt(0).toUpperCase()}
        </span>
      ) : null}
      <div className="ma-caption-line__body">
        <div className="ma-caption-line__meta">
          {line.speakerKey ? <span className="ma-caption-line__speaker">{badgeLabel}</span> : null}
          <span className="ma-caption-line__time">{formatTimestamp(line.atSec)}</span>
        </div>
        <p className="ma-caption-line__text">{line.text}</p>
        {line.translation ? <p className="ma-caption-line__translation">{line.translation}</p> : null}
      </div>
      {onBookmark ? (
        <button type="button" className="ma-caption-line__bookmark" aria-label={t('recording.bookmark.add')} onClick={onBookmark}>
          <Icon name="bookmark-add" size={16} />
        </button>
      ) : null}
    </div>
  );
}
