/**
 * One caption row in the light "Transcript" view (1a): speaker avatar, a
 * speaker-name button that opens the per-segment speaker picker (the diarizer
 * mixes voices up — every segment can be corrected), mm:ss, the caption text
 * with its translation directly underneath, and a bookmark button.
 */
import { useEffect, useState } from 'react';

import type { CaptionLine as CaptionLineData, LiveSpeakerBadge } from '../stores/recording-store.js';
import type { RealtimeAssignChoice } from '../data/speaker-api.js';
import { useI18n } from '../i18n/i18n-provider.js';
import { Icon } from './icon.js';
import { LineSpeakerPicker, type PickerSpeaker } from './line-speaker-picker.js';
import { QuickAssignPopover } from './quick-assign-popover.js';

export interface CaptionLineProps {
  line: CaptionLineData;
  /** Badge of the EFFECTIVE speaker (after manual corrections). */
  speaker?: LiveSpeakerBadge;
  /** Effective speaker key (after manual corrections), if the line has a speaker at all. */
  speakerKey?: string;
  speakerIndex: number;
  roomId: string;
  /** Every known speaker, for the picker. Empty → the name is not interactive (provider without labels). */
  speakers: readonly PickerSpeaker[];
  onReassign?(toSpeakerKey: string, applyToVoice: boolean): void;
  onAddSpeaker?(applyToVoice: boolean): void;
  onRename?(speakerKey: string, choice: RealtimeAssignChoice): void;
  /** Fires when this line's speaker menu opens/closes, so the transcript can stop auto-scrolling while it is open. */
  onMenuOpenChange?(open: boolean): void;
  onBookmark?: () => void;
}

function formatTimestamp(atSec: number): string {
  const minutes = Math.floor(atSec / 60);
  const seconds = Math.floor(atSec % 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function CaptionLine({ line, speaker, speakerKey, speakerIndex, roomId, speakers, onReassign, onAddSpeaker, onRename, onMenuOpenChange, onBookmark }: CaptionLineProps) {
  const { t } = useI18n();
  const [menu, setMenu] = useState<'closed' | 'picker' | 'rename'>('closed');
  useEffect(() => { onMenuOpenChange?.(menu !== 'closed'); }, [menu, onMenuOpenChange]);
  const badgeLabel = speaker?.displayName ?? (speakerKey ? t('recording.speakerBadge.numbered', { n: speakerIndex }) : t('recording.speakerBadge.speaking'));
  const interactive = Boolean(speakerKey) && speakers.length > 0;

  return (
    <div className={`ma-caption-line${line.isFinal ? '' : ' ma-caption-line--draft'}`}>
      {speakerKey ? (
        <span className={`ma-caption-line__avatar ma-caption-line__avatar--${speaker?.colorKey ?? 'blue'}`} aria-hidden="true">
          {badgeLabel.charAt(0).toUpperCase()}
        </span>
      ) : null}
      <div className="ma-caption-line__body">
        <div className="ma-caption-line__meta">
          {speakerKey ? (
            interactive ? (
              <button
                type="button"
                className={`ma-caption-line__speaker ma-caption-line__speaker--button${menu !== 'closed' ? ' ma-caption-line__speaker--open' : ''}`}
                aria-haspopup="menu"
                aria-expanded={menu === 'picker'}
                onClick={() => setMenu(menu === 'closed' ? 'picker' : 'closed')}
              >
                {badgeLabel}
                <Icon name="chevron-down" size={12} />
              </button>
            ) : (
              <span className="ma-caption-line__speaker">{badgeLabel}</span>
            )
          ) : null}
          {line.isFinal ? <span className="ma-caption-line__time">{formatTimestamp(line.atSec)}</span> : <span className="ma-caption-line__speaking">{t('recording.speakerBadge.speakingNow')}</span>}

          {menu === 'picker' && speakerKey ? (
            <LineSpeakerPicker
              speakers={speakers}
              currentKey={speakerKey}
              onClose={() => setMenu('closed')}
              onPick={(toKey, applyToVoice) => {
                setMenu('closed');
                onReassign?.(toKey, applyToVoice);
              }}
              onRename={() => setMenu('rename')}
              onAddSpeaker={(applyToVoice) => {
                setMenu('closed');
                onAddSpeaker?.(applyToVoice);
              }}
            />
          ) : null}
          {menu === 'rename' && speakerKey ? (
            <QuickAssignPopover
              roomId={roomId}
              speakerId={speakerKey}
              onClose={() => setMenu('closed')}
              onAssign={(choice) => {
                setMenu('closed');
                onRename?.(speakerKey, choice);
              }}
            />
          ) : null}
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
