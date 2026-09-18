/**
 * "Ai đang nói?" quick-assign popover (plan.md § UI): pick a room member,
 * type a name, or "cùng người với …" (merge into an existing profile) — all
 * three call `speaker_resolve` with `speakerId = sessionSpeakerId` (P4's tool
 * already accepts a session id as a fallback lookup key, see
 * `speaker-resolve-tool.ts`'s `findSpeakerRow`). A cluster that is not yet
 * coherent enough to enrol still gets NAMED immediately (`enrolled:false`,
 * `reason:'cluster_not_coherent'`/`'no_pending_embedding'`) — that is
 * success from this popover's point of view, not an error.
 */
import { useEffect, useState } from 'react';
import { usePrivosApp } from '@privos_ai/app-react';

import { speakerProfileList, speakerResolve, type SpeakerProfileListItem, type SpeakerResolveMode } from '../data/speaker-api.js';
import type { RoomMember } from '../data/room-members.js';
import { useI18n } from '../i18n/i18n-provider.js';
import { MemberPicker } from './member-picker.js';

export interface QuickAssignPopoverProps {
  roomId: string;
  meetingId: string;
  sessionSpeakerId: string;
  currentLabel: string;
  onClose(): void;
  onResolved(displayName: string): void;
}

export function QuickAssignPopover({ roomId, meetingId, sessionSpeakerId, currentLabel, onClose, onResolved }: QuickAssignPopoverProps) {
  const app = usePrivosApp();
  const { t } = useI18n();
  const [mode, setMode] = useState<SpeakerResolveMode>('name');
  const [displayName, setDisplayName] = useState('');
  const [member, setMember] = useState<RoomMember | undefined>();
  const [profileId, setProfileId] = useState('');
  const [profiles, setProfiles] = useState<SpeakerProfileListItem[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    speakerProfileList(app)
      .then(setProfiles)
      .catch(() => setProfiles([]));
  }, [app]);

  async function submit(): Promise<void> {
    setSubmitting(true);
    setError(null);
    try {
      const assignment =
        mode === 'user'
          ? { speakerId: sessionSpeakerId, mode: 'user' as const, privosUserId: member?.id, displayName: member?.name }
          : mode === 'merge'
            ? { speakerId: sessionSpeakerId, mode: 'merge' as const, profileId }
            : { speakerId: sessionSpeakerId, mode: 'name' as const, displayName };
      const [result] = await speakerResolve(app, roomId, meetingId, [assignment]);
      if (result.reason === 'not_found') {
        // The chunk worker has not written this session speaker's row yet — too early to quick-assign.
        setError(t('speaker.quickAssign.notFoundYet'));
        return;
      }
      onResolved(result.displayName ?? displayName ?? member?.name ?? currentLabel);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="ma-quick-assign" role="dialog" aria-label={t('speaker.quickAssign.title')}>
      <div className="ma-quick-assign__modes" role="radiogroup" aria-label={t('speaker.resolveModal.modeGroupLabel')}>
        <label>
          <input type="radio" name={`qa-mode-${sessionSpeakerId}`} checked={mode === 'user'} onChange={() => setMode('user')} />
          {t('speaker.resolveModal.modeUser')}
        </label>
        <label>
          <input type="radio" name={`qa-mode-${sessionSpeakerId}`} checked={mode === 'name'} onChange={() => setMode('name')} />
          {t('speaker.resolveModal.modeName')}
        </label>
        <label>
          <input type="radio" name={`qa-mode-${sessionSpeakerId}`} checked={mode === 'merge'} onChange={() => setMode('merge')} />
          {t('speaker.quickAssign.samePersonAs')}
        </label>
      </div>

      {mode === 'user' ? <MemberPicker selectedLabel={member?.name} onSelect={setMember} /> : null}
      {mode === 'name' ? (
        <input
          className="ma-resolve-speakers__name-input"
          value={displayName}
          maxLength={80}
          autoFocus
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder={t('speaker.resolveModal.namePlaceholder')}
        />
      ) : null}
      {mode === 'merge' ? (
        <select className="ma-resolve-speakers__profile-select" value={profileId} onChange={(e) => setProfileId(e.target.value)}>
          <option value="">{t('speaker.resolveModal.pickProfile')}</option>
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.displayName}
            </option>
          ))}
        </select>
      ) : null}

      {error ? (
        <p className="ma-resolve-speakers__error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="ma-quick-assign__actions">
        <button type="button" className="ma-resolve-speakers__later" onClick={onClose} disabled={submitting}>
          {t('speaker.resolveModal.later')}
        </button>
        <button type="button" className="ma-resolve-speakers__submit" onClick={() => void submit()} disabled={submitting}>
          {submitting ? t('speaker.resolveModal.submitting') : t('speaker.resolveModal.submit')}
        </button>
      </div>
    </div>
  );
}
