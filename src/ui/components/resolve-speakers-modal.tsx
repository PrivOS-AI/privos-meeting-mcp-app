/**
 * "Confirm speaker" modal (plan.md § UI). Opens when a meeting finishes
 * processing with `result.speakers` still containing an unresolved entry.
 * Each row lets the owner pick one of 3 modes (`speaker_resolve`'s `user` /
 * `name` / `merge`) or skip; submit calls `speaker_resolve` once for every
 * row in a single batch. Sample playback (seek `audio.webm` to
 * `sampleRange.startSec`) is deferred to P7's presigned-audio player — this
 * modal shows duration/confidence only, no audio scrub, since P4 does not
 * own a Files presign helper.
 */
import { useEffect, useState } from 'react';
import { usePrivosApp } from '@privos_ai/app-react';

import { speakerProfileList, speakerResolve, type SpeakerProfileListItem, type SpeakerResolveAssignment, type SpeakerResolveMode, type SpeakerResolveResult } from '../data/speaker-api.js';
import type { RoomMember } from '../data/room-members.js';
import { useI18n } from '../i18n/i18n-provider.js';
import { MemberPicker } from './member-picker.js';
import { SpeakerAvatar } from './speaker-avatar.js';

const PALETTE = ['blue', 'gold', 'green', 'purple', 'coral', 'teal'] as const;

export interface UnresolvedSpeaker {
  speakerId: string;
  totalSpeakSec: number;
  displayName?: string | null;
  confidence?: number;
}

export interface ResolveSpeakersModalProps {
  roomId: string;
  meetingId: string;
  speakers: readonly UnresolvedSpeaker[];
  onClose(): void;
  onResolved(results: SpeakerResolveResult[]): void;
}

interface RowState {
  mode: SpeakerResolveMode;
  displayName: string;
  member?: RoomMember;
  profileId?: string;
}

function formatDurationSec(sec: number): string {
  const total = Math.max(0, Math.round(sec));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function ResolveSpeakersModal({ roomId, meetingId, speakers, onClose, onResolved }: ResolveSpeakersModalProps) {
  const app = usePrivosApp();
  const { t } = useI18n();
  const [profiles, setProfiles] = useState<SpeakerProfileListItem[]>([]);
  const [rows, setRows] = useState<Record<string, RowState>>(() =>
    Object.fromEntries(speakers.map((s) => [s.speakerId, { mode: 'name' as SpeakerResolveMode, displayName: '' }])),
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    speakerProfileList(app)
      .then(setProfiles)
      .catch(() => setProfiles([]));
  }, [app]);

  function updateRow(speakerId: string, patch: Partial<RowState>): void {
    setRows((prev) => ({ ...prev, [speakerId]: { ...prev[speakerId], ...patch } }));
  }

  async function submit(): Promise<void> {
    setSubmitting(true);
    setError(null);
    try {
      const assignments: SpeakerResolveAssignment[] = speakers.map((s) => {
        const row = rows[s.speakerId];
        if (row.mode === 'user') return { speakerId: s.speakerId, mode: 'user', privosUserId: row.member?.id, displayName: row.member?.name };
        if (row.mode === 'merge') return { speakerId: s.speakerId, mode: 'merge', profileId: row.profileId };
        if (row.mode === 'skip') return { speakerId: s.speakerId, mode: 'skip' };
        return { speakerId: s.speakerId, mode: 'name', displayName: row.displayName };
      });
      const results = await speakerResolve(app, roomId, meetingId, assignments);
      onResolved(results);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="ma-modal-overlay" role="dialog" aria-modal="true" aria-labelledby="ma-resolve-speakers-title">
      <div className="ma-modal ma-resolve-speakers">
        <h2 id="ma-resolve-speakers-title">{t('speaker.resolveModal.title')}</h2>
        <p className="ma-resolve-speakers__subtitle">{t('speaker.resolveModal.subtitle')}</p>

        <ul className="ma-resolve-speakers__list">
          {speakers.map((s, index) => {
            const row = rows[s.speakerId];
            const colorKey = PALETTE[index % PALETTE.length];
            const label = s.displayName || t('speaker.numbered', { n: index + 1 });
            return (
              <li key={s.speakerId} className="ma-resolve-speakers__row">
                <SpeakerAvatar name={label} colorKey={colorKey} />
                <div className="ma-resolve-speakers__row-body">
                  <div className="ma-resolve-speakers__row-header">
                    <strong>{label}</strong>
                    <span className="ma-resolve-speakers__duration">{formatDurationSec(s.totalSpeakSec)}</span>
                  </div>

                  <div className="ma-resolve-speakers__modes" role="radiogroup" aria-label={t('speaker.resolveModal.modeGroupLabel')}>
                    <label>
                      <input type="radio" name={`mode-${s.speakerId}`} checked={row.mode === 'user'} onChange={() => updateRow(s.speakerId, { mode: 'user' })} />
                      {t('speaker.resolveModal.modeUser')}
                    </label>
                    <label>
                      <input type="radio" name={`mode-${s.speakerId}`} checked={row.mode === 'name'} onChange={() => updateRow(s.speakerId, { mode: 'name' })} />
                      {t('speaker.resolveModal.modeName')}
                    </label>
                    <label>
                      <input type="radio" name={`mode-${s.speakerId}`} checked={row.mode === 'merge'} onChange={() => updateRow(s.speakerId, { mode: 'merge' })} />
                      {t('speaker.resolveModal.modeMerge')}
                    </label>
                    <label>
                      <input type="radio" name={`mode-${s.speakerId}`} checked={row.mode === 'skip'} onChange={() => updateRow(s.speakerId, { mode: 'skip' })} />
                      {t('speaker.resolveModal.modeSkip')}
                    </label>
                  </div>

                  {row.mode === 'user' ? (
                    <MemberPicker selectedLabel={row.member?.name} onSelect={(member) => updateRow(s.speakerId, { member, displayName: member.name })} />
                  ) : null}

                  {row.mode === 'name' ? (
                    <input
                      className="ma-resolve-speakers__name-input"
                      value={row.displayName}
                      maxLength={80}
                      onChange={(e) => updateRow(s.speakerId, { displayName: e.target.value })}
                      placeholder={t('speaker.resolveModal.namePlaceholder')}
                    />
                  ) : null}

                  {row.mode === 'merge' ? (
                    <select className="ma-resolve-speakers__profile-select" value={row.profileId ?? ''} onChange={(e) => updateRow(s.speakerId, { profileId: e.target.value })}>
                      <option value="">{t('speaker.resolveModal.pickProfile')}</option>
                      {profiles.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.displayName}
                        </option>
                      ))}
                    </select>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>

        {error ? (
          <p className="ma-resolve-speakers__error" role="alert">
            {error}
          </p>
        ) : null}

        <div className="ma-resolve-speakers__actions">
          <button type="button" className="ma-resolve-speakers__later" onClick={onClose} disabled={submitting}>
            {t('speaker.resolveModal.later')}
          </button>
          <button type="button" className="ma-resolve-speakers__submit" onClick={() => void submit()} disabled={submitting}>
            {submitting ? t('speaker.resolveModal.submitting') : t('speaker.resolveModal.submit')}
          </button>
        </div>
      </div>
    </div>
  );
}
