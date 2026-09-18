/**
 * Reusable "sửa nhãn người nói" control (plan.md § UI) — pick an existing
 * profile or type a new name, then calls `meeting_relabel_speaker` (which
 * back-propagates the voiceprint on the backend). Meant to be mounted inside
 * the meeting-detail speaker list once P7 builds that screen; kept
 * standalone/domain-agnostic here so P7 only has to render it, not
 * reimplement the save flow.
 */
import { useState } from 'react';
import { usePrivosApp } from '@privos_ai/app-react';

import { meetingRelabelSpeaker, type SpeakerProfileListItem } from '../data/speaker-api.js';
import { useI18n } from '../i18n/i18n-provider.js';

export interface SpeakerLabelEditorProps {
  roomId: string;
  meetingId: string;
  speakerId: string;
  currentDisplayName: string;
  profiles: readonly SpeakerProfileListItem[];
  onUpdated(result: { profileId: string; displayName: string }): void;
}

type Mode = 'pick' | 'name';

export function SpeakerLabelEditor({ roomId, meetingId, speakerId, currentDisplayName, profiles, onUpdated }: SpeakerLabelEditorProps) {
  const app = usePrivosApp();
  const { t } = useI18n();
  const [mode, setMode] = useState<Mode>(profiles.length > 0 ? 'pick' : 'name');
  const [profileId, setProfileId] = useState('');
  const [displayName, setDisplayName] = useState(currentDisplayName);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSave = mode === 'pick' ? Boolean(profileId) : displayName.trim().length > 0;

  async function save(): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      const result = await meetingRelabelSpeaker(app, {
        roomId,
        meetingId,
        speakerId,
        profileId: mode === 'pick' ? profileId : undefined,
        displayName: mode === 'name' ? displayName.trim() : undefined,
      });
      onUpdated({ profileId: result.profileId, displayName: result.displayName });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="ma-speaker-label-editor">
      <select className="ma-speaker-label-editor__mode" value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
        <option value="pick">{t('speaker.labelEditor.pickExisting')}</option>
        <option value="name">{t('speaker.labelEditor.typeNew')}</option>
      </select>

      {mode === 'pick' ? (
        <select className="ma-speaker-label-editor__profile" value={profileId} onChange={(e) => setProfileId(e.target.value)}>
          <option value="">{t('speaker.resolveModal.pickProfile')}</option>
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.displayName}
            </option>
          ))}
        </select>
      ) : (
        <input
          className="ma-speaker-label-editor__name"
          value={displayName}
          maxLength={80}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder={t('speaker.resolveModal.namePlaceholder')}
        />
      )}

      {error ? <span className="ma-speaker-label-editor__error">{error}</span> : null}

      <button type="button" className="ma-speaker-label-editor__save" onClick={() => void save()} disabled={saving || !canSave}>
        {saving ? t('speaker.labelEditor.saving') : t('speaker.labelEditor.save')}
      </button>
    </div>
  );
}
