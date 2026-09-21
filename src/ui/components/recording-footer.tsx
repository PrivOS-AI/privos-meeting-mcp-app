/**
 * Footer control bar shared by 1a (Transcript) and 1b (Stage): mic mute, the
 * live waveform, pause/resume, End & summarize.
 */
import type { ReactNode } from 'react';

import { useI18n } from '../i18n/i18n-provider.js';
import { Icon } from './icon.js';

export interface RecordingFooterProps {
  muted: boolean;
  paused: boolean;
  ending: boolean;
  /** The live waveform, shown between the controls. */
  waveform?: ReactNode;
  onToggleMute(): void;
  onTogglePause(): void;
  onEnd(): void;
}

export function RecordingFooter({ muted, paused, ending, waveform, onToggleMute, onTogglePause, onEnd }: RecordingFooterProps) {
  const { t } = useI18n();
  return (
    <div className="ma-rec-footer">
      <div className="ma-rec-footer__group">
        <button type="button" className="ma-rec-footer__icon-btn" aria-pressed={muted} aria-label={t('recording.footer.mute')} onClick={onToggleMute}>
          <Icon name={muted ? 'microphone-off' : 'microphone'} size={20} />
        </button>
        <button type="button" className="ma-rec-footer__icon-btn" aria-label={paused ? t('recording.footer.resume') : t('recording.footer.pause')} onClick={onTogglePause}>
          <Icon name={paused ? 'play' : 'pause'} size={20} />
        </button>
      </div>
      {waveform ? <div className="ma-rec-footer__wave">{waveform}</div> : null}
      <button type="button" className="ma-rec-footer__end" disabled={ending} onClick={onEnd}>
        {ending ? t('recording.footer.ending') : t('recording.footer.end')}
      </button>
    </div>
  );
}
