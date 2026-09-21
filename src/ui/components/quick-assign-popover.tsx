/**
 * "Who's speaking?" quick-assign popover: pick a room member, type a name, or
 * "same person as …" (merge into an existing profile). It only COLLECTS the
 * choice and hands it back via `onAssign` — the recording store applies the
 * label immediately and defers enrolment (`speaker_resolve`) until a session
 * speaker exists for this realtime speaker, so a user can name someone from the
 * first second without waiting on the embedding pipeline.
 */
import { useEffect, useState } from 'react';
import { usePrivosApp } from '@privos_ai/app-react';

import { speakerProfileList, type RealtimeAssignChoice, type SpeakerProfileListItem, type SpeakerResolveMode } from '../data/speaker-api.js';
import type { RoomMember } from '../data/room-members.js';
import { useI18n } from '../i18n/i18n-provider.js';
import { MemberPicker } from './member-picker.js';

export interface QuickAssignPopoverProps {
  roomId: string;
  /** The realtime speaker key this popover assigns (used only to scope the radio group ids). */
  speakerId: string;
  onClose(): void;
  onAssign(choice: RealtimeAssignChoice): void;
}

export function QuickAssignPopover({ speakerId, onClose, onAssign }: QuickAssignPopoverProps) {
  const app = usePrivosApp();
  const { t } = useI18n();
  const [mode, setMode] = useState<SpeakerResolveMode>('name');
  const [displayName, setDisplayName] = useState('');
  const [member, setMember] = useState<RoomMember | undefined>();
  const [profileId, setProfileId] = useState('');
  const [profiles, setProfiles] = useState<SpeakerProfileListItem[]>([]);

  useEffect(() => {
    speakerProfileList(app)
      .then(setProfiles)
      .catch(() => setProfiles([]));
  }, [app]);

  function submit(): void {
    const choice: RealtimeAssignChoice =
      mode === 'user'
        ? { mode: 'user', privosUserId: member?.id, displayName: member?.name }
        : mode === 'merge'
          ? { mode: 'merge', profileId, displayName: profiles.find((p) => p.id === profileId)?.displayName }
          : { mode: 'name', displayName: displayName.trim() };
    onAssign(choice);
  }

  const canSubmit = mode === 'user' ? Boolean(member) : mode === 'merge' ? Boolean(profileId) : displayName.trim().length > 0;

  return (
    <div className="ma-quick-assign" role="dialog" aria-label={t('speaker.quickAssign.title')}>
      <div className="ma-quick-assign__modes" role="radiogroup" aria-label={t('speaker.resolveModal.modeGroupLabel')}>
        <label>
          <input type="radio" name={`qa-mode-${speakerId}`} checked={mode === 'user'} onChange={() => setMode('user')} />
          {t('speaker.resolveModal.modeUser')}
        </label>
        <label>
          <input type="radio" name={`qa-mode-${speakerId}`} checked={mode === 'name'} onChange={() => setMode('name')} />
          {t('speaker.resolveModal.modeName')}
        </label>
        <label>
          <input type="radio" name={`qa-mode-${speakerId}`} checked={mode === 'merge'} onChange={() => setMode('merge')} />
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

      <div className="ma-quick-assign__actions">
        <button type="button" className="ma-resolve-speakers__later" onClick={onClose}>
          {t('speaker.resolveModal.later')}
        </button>
        <button type="button" className="ma-resolve-speakers__submit" onClick={submit} disabled={!canSubmit}>
          {t('speaker.resolveModal.submit')}
        </button>
      </div>
    </div>
  );
}
