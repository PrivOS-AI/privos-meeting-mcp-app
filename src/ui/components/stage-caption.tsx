/**
 * Dark full-bleed "Stage" caption view (1b): the last two lines fade to
 * 32%/60% opacity as history, the current line renders large with a blinking
 * cursor while still a draft.
 */
import type { CaptionLine, LiveSpeakerBadge, StageCaptionSize } from '../stores/recording-store.js';
import { useI18n } from '../i18n/i18n-provider.js';

export interface StageCaptionProps {
  lines: CaptionLine[];
  speakerMap: Record<string, LiveSpeakerBadge>;
  size: StageCaptionSize;
  /** Effective speaker of a line after manual corrections; defaults to the diarized key. */
  resolveSpeakerKey?(line: CaptionLine): string | undefined;
}

const SIZE_PX: Record<StageCaptionSize, number> = { small: 30, medium: 38, large: 46 };

export function StageCaption({ lines, speakerMap, size, resolveSpeakerKey }: StageCaptionProps) {
  const { t } = useI18n();
  const visible = lines.slice(-3);
  const [older, recent, current] = [visible[visible.length - 3], visible[visible.length - 2], visible[visible.length - 1]];
  // Manual corrections apply on the stage too.
  const currentKey = current ? (resolveSpeakerKey ? resolveSpeakerKey(current) : current.speakerKey) : undefined;

  return (
    <div className="ma-stage-caption">
      {older ? <p className="ma-stage-caption__line ma-stage-caption__line--history1">{older.text}</p> : null}
      {recent ? <p className="ma-stage-caption__line ma-stage-caption__line--history2">{recent.text}</p> : null}
      {current ? (
        <p className="ma-stage-caption__line ma-stage-caption__line--current" style={{ fontSize: SIZE_PX[size] }}>
          {currentKey ? (
            <span className={`ma-stage-caption__chip ma-stage-caption__chip--${speakerMap[currentKey]?.colorKey ?? 'blue'}`}>
              {speakerMap[currentKey]?.displayName ?? t('recording.speakerBadge.speaking')}
            </span>
          ) : null}
          {current.text}
          {!current.isFinal ? <span className="ma-stage-caption__cursor" aria-hidden="true" /> : null}
        </p>
      ) : null}
    </div>
  );
}
