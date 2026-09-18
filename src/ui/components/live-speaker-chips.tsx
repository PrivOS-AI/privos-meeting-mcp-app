/**
 * "Ai đang nói?" chip row on the live screen (plan.md § UI). One chip per
 * active session speaker (merged-away entries never render their own chip —
 * their labels already live on the winner). Clicking a chip opens
 * `QuickAssignPopover` for that `sessionSpeakerId`. A `degraded` badge in the
 * row explains that some segments could not be identified yet (a chunk was
 * dropped/failed) rather than silently looking broken.
 */
import { useState } from 'react';

import { useI18n } from '../i18n/i18n-provider.js';
import type { LiveSpeaker } from '../data/live-speaker-poll.js';
import { QuickAssignPopover } from './quick-assign-popover.js';
import { SpeakerAvatar } from './speaker-avatar.js';

export interface LiveSpeakerChipsProps {
  roomId: string;
  meetingId: string;
  speakers: readonly LiveSpeaker[];
  degraded: boolean;
  onResolved(sessionSpeakerId: string, displayName: string): void;
}

function formatSeconds(sec: number): string {
  const total = Math.max(0, Math.round(sec));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`;
}

export function LiveSpeakerChips({ roomId, meetingId, speakers, degraded, onResolved }: LiveSpeakerChipsProps) {
  const { t } = useI18n();
  const [openFor, setOpenFor] = useState<string | null>(null);

  const active = speakers.filter((s) => !s.mergedInto);
  if (active.length === 0 && !degraded) return null;

  return (
    <div className="ma-speaker-chips" role="group" aria-label={t('recording.speakerChips.label')}>
      {active.map((speaker, index) => {
        const label = speaker.displayName || t('speaker.numbered', { n: index + 1 });
        return (
          <div key={speaker.sessionSpeakerId} className="ma-speaker-chip-wrap">
            <button
              type="button"
              className={`ma-speaker-chip${speaker.resolved ? ' ma-speaker-chip--resolved' : ''}`}
              onClick={() => setOpenFor(openFor === speaker.sessionSpeakerId ? null : speaker.sessionSpeakerId)}
            >
              <SpeakerAvatar name={label} colorKey={speaker.colorKey} size={22} />
              <span className="ma-speaker-chip__name">{speaker.resolved ? label : t('recording.speakerChips.identifying')}</span>
              <span className="ma-speaker-chip__seconds">{formatSeconds(speaker.liveSpeechSec)}</span>
            </button>
            {openFor === speaker.sessionSpeakerId ? (
              <QuickAssignPopover
                roomId={roomId}
                meetingId={meetingId}
                sessionSpeakerId={speaker.sessionSpeakerId}
                currentLabel={label}
                onClose={() => setOpenFor(null)}
                onResolved={(displayName) => {
                  setOpenFor(null);
                  onResolved(speaker.sessionSpeakerId, displayName);
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
