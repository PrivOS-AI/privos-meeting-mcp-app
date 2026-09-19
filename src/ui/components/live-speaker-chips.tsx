/**
 * "Who's speaking?" chip row on the live screen. One chip per REALTIME speaker
 * (Soniox `speaker` label) — so a chip appears from the first token, letting the
 * user name a speaker immediately. Clicking a chip opens `QuickAssignPopover`;
 * the chosen name is applied to every line of that speaker at once and the
 * recording store enrols the voiceprint once a session speaker forms for it. A
 * `degraded` badge explains that some segments could not be identified yet.
 */
import { useState } from 'react';

import { useI18n } from '../i18n/i18n-provider.js';
import type { RealtimeAssignChoice } from '../data/speaker-api.js';
import { QuickAssignPopover } from './quick-assign-popover.js';
import { SpeakerAvatar } from './speaker-avatar.js';

export interface RealtimeSpeakerChip {
  speakerKey: string;
  displayName?: string;
  colorKey: string;
  resolved: boolean;
}

export interface LiveSpeakerChipsProps {
  roomId: string;
  speakers: readonly RealtimeSpeakerChip[];
  degraded: boolean;
  onAssign(speakerKey: string, choice: RealtimeAssignChoice): void;
}

export function LiveSpeakerChips({ roomId, speakers, degraded, onAssign }: LiveSpeakerChipsProps) {
  const { t } = useI18n();
  const [openFor, setOpenFor] = useState<string | null>(null);

  if (speakers.length === 0 && !degraded) return null;

  return (
    <div className="ma-speaker-chips" role="group" aria-label={t('recording.speakerChips.label')}>
      {speakers.map((speaker, index) => {
        const label = speaker.displayName || t('speaker.numbered', { n: index + 1 });
        return (
          <div key={speaker.speakerKey} className="ma-speaker-chip-wrap">
            <button
              type="button"
              className={`ma-speaker-chip${speaker.resolved ? ' ma-speaker-chip--resolved' : ''}`}
              onClick={() => setOpenFor(openFor === speaker.speakerKey ? null : speaker.speakerKey)}
            >
              <SpeakerAvatar name={label} colorKey={speaker.colorKey} size={22} />
              <span className="ma-speaker-chip__name">{label}</span>
            </button>
            {openFor === speaker.speakerKey ? (
              <QuickAssignPopover
                roomId={roomId}
                speakerId={speaker.speakerKey}
                onClose={() => setOpenFor(null)}
                onAssign={(choice) => {
                  setOpenFor(null);
                  onAssign(speaker.speakerKey, choice);
                }}
              />
            ) : null}
          </div>
        );
      })}
      {degraded ? <span className="ma-speaker-chips__degraded">{t('recording.speakerChips.degraded')}</span> : null}
    </div>
  );
}
