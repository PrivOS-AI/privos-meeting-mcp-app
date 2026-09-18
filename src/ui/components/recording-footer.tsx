/**
 * Footer control bar shared by 1a (Transcript) and 1b (Stage): mic mute,
 * caption text size, bookmark, pause/resume, End & summarize.
 */
import { useI18n } from '../i18n/i18n-provider.js';
import type { StageCaptionSize } from '../stores/recording-store.js';
import { Icon } from './icon.js';

export interface RecordingFooterProps {
  muted: boolean;
  paused: boolean;
  stageCaptionSize: StageCaptionSize;
  ending: boolean;
  onToggleMute(): void;
  onCycleSize(): void;
  onBookmark(): void;
  onTogglePause(): void;
  onEnd(): void;
}

const SIZE_CYCLE: StageCaptionSize[] = ['small', 'medium', 'large'];

export function RecordingFooter({ muted, paused, stageCaptionSize, ending, onToggleMute, onCycleSize, onBookmark, onTogglePause, onEnd }: RecordingFooterProps) {
  const { t } = useI18n();
  return (
    <div className="ma-rec-footer">
      <div className="ma-rec-footer__group">
        <button type="button" className="ma-rec-footer__icon-btn" aria-pressed={muted} aria-label={t('recording.footer.mute')} onClick={onToggleMute}>
          <Icon name={muted ? 'microphone-off' : 'microphone'} size={20} />
        </button>
        <button type="button" className="ma-rec-footer__icon-btn" aria-label={t('recording.footer.textSize')} onClick={onCycleSize}>
          <Icon name="text-font-size" size={20} />
          <span className="ma-rec-footer__size-label">{SIZE_CYCLE.indexOf(stageCaptionSize) + 1}/3</span>
        </button>
        <button type="button" className="ma-rec-footer__icon-btn" aria-label={t('recording.bookmark.add')} onClick={onBookmark}>
          <Icon name="bookmark-add" size={20} />
        </button>
        <button type="button" className="ma-rec-footer__icon-btn" aria-label={paused ? t('recording.footer.resume') : t('recording.footer.pause')} onClick={onTogglePause}>
          <Icon name={paused ? 'play' : 'pause'} size={20} />
        </button>
      </div>
      <button type="button" className="ma-rec-footer__end" disabled={ending} onClick={onEnd}>
        {ending ? t('recording.footer.ending') : t('recording.footer.end')}
      </button>
    </div>
  );
}
