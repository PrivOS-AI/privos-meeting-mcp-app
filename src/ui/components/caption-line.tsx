/**
 * One caption row in the light "Transcript" view (1a): speaker avatar, a
 * speaker-name button that opens the per-segment speaker picker (the diarizer
 * mixes voices up — every segment can be corrected), mm:ss, the caption text
 * with its translation directly underneath, and a bookmark button.
 */
import { useState } from 'react';

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
  onAddSpeaker?(name: string, applyToVoice: boolean): void;
  onRename?(speakerKey: string, choice: RealtimeAssignChoice): void;
  /** 'clock' = elapsed since meeting start (mm:ss); 'wall' = real time of day (HH:MM:SS). */
  timeMode?: 'clock' | 'wall';
  onToggleTimeMode?(): void;
  /** Meeting start wall-clock in ms — turns a line's `atSec` into a real time of day. */
  startedAtMs?: number;
  /** This segment is already bookmarked — its bookmark icon shows as ticked/filled. */
  bookmarked?: boolean;
  onBookmark?: () => void;
}

function formatTimestamp(atSec: number): string {
  const minutes = Math.floor(atSec / 60);
  const seconds = Math.floor(atSec % 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/** Real time of day this segment was spoken, e.g. "14:30:22". */
function formatWallClock(atSec: number, startedAtMs: number): string {
  return new Date(startedAtMs + atSec * 1000).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function CaptionLine({ line, speaker, speakerKey, speakerIndex, roomId, speakers, onReassign, onAddSpeaker, onRename, timeMode = 'clock', onToggleTimeMode, startedAtMs = 0, bookmarked = false, onBookmark }: CaptionLineProps) {
  const { t } = useI18n();
  const [menu, setMenu] = useState<'closed' | 'picker' | 'rename'>('closed');
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
          {line.isFinal ? (
            <button
              type="button"
              className="ma-caption-line__time"
              title={t('recording.time.toggle')}
              aria-label={t('recording.time.toggle')}
              onClick={onToggleTimeMode}
            >
              {timeMode === 'wall' ? formatWallClock(line.atSec, startedAtMs) : formatTimestamp(line.atSec)}
            </button>
          ) : (
            <span className="ma-caption-line__speaking">{t('recording.speakerBadge.speakingNow')}</span>
          )}

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
              onAddSpeaker={(name, applyToVoice) => {
                setMenu('closed');
                onAddSpeaker?.(name, applyToVoice);
              }}
            />
          ) : null}
          {menu === 'rename' && speakerKey ? (
            <>
              <button
                type="button"
                className="ma-caption-line__modal-scrim"
                aria-label={t('speaker.linePicker.close')}
                onClick={() => setMenu('closed')}
              />
              <QuickAssignPopover
                roomId={roomId}
                speakerId={speakerKey}
                onClose={() => setMenu('closed')}
                onAssign={(choice) => {
                  setMenu('closed');
                  onRename?.(speakerKey, choice);
                }}
              />
            </>
          ) : null}
        </div>
        <p className="ma-caption-line__text">{line.text}</p>
        {line.translation ? <p className="ma-caption-line__translation">{line.translation}</p> : null}
      </div>
      {onBookmark ? (
        <button
          type="button"
          className={`ma-caption-line__bookmark${bookmarked ? ' ma-caption-line__bookmark--on' : ''}`}
          aria-label={t(bookmarked ? 'recording.bookmark.saved' : 'recording.bookmark.add')}
          aria-pressed={bookmarked}
          disabled={bookmarked}
          onClick={onBookmark}
        >
          <Icon name={bookmarked ? 'bookmark-check' : 'bookmark-add'} size={16} />
        </button>
      ) : null}
    </div>
  );
}
