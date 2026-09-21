/**
 * Meeting detail's speaker list with inline relabel (phase-07 §
 * Requirements: "Edit the speaker label right on the transcript line... → tool
 * `meeting_relabel_speaker`"). Names shown here come from the RECONCILED
 * `meeting_speakers` rows (P3/P5), not live labels (plan.md). Reuses P4's
 * `speaker-label-editor.tsx` as-is; only one row is ever in edit mode.
 */
import { useEffect, useState } from 'react';
import { usePrivosApp } from '@privos_ai/app-react';

import { speakerProfileList, type SpeakerProfileListItem } from '../data/speaker-api.js';
import { useI18n } from '../i18n/i18n-provider.js';
import { SpeakerAvatar } from './speaker-avatar.js';
import { SpeakerLabelEditor } from './speaker-label-editor.js';

export interface MeetingSpeakerRow {
  speakerId: string;
  displayName: string;
  colorKey: string;
}

export interface MeetingSpeakersPanelProps {
  roomId: string;
  meetingId: string;
  speakers: MeetingSpeakerRow[];
  onRelabeled(speakerId: string, displayName: string): void;
}

export function MeetingSpeakersPanel({ roomId, meetingId, speakers, onRelabeled }: MeetingSpeakersPanelProps) {
  const app = usePrivosApp();
  const { t } = useI18n();
  const [profiles, setProfiles] = useState<SpeakerProfileListItem[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);

  useEffect(() => {
    speakerProfileList(app)
      .then(setProfiles)
      .catch(() => setProfiles([]));
  }, [app]);

  return (
    <ul className="ma-meeting-speakers__list">
      {speakers.map((speaker) => (
        <li key={speaker.speakerId} className="ma-meeting-speakers__row">
          <SpeakerAvatar name={speaker.displayName} colorKey={speaker.colorKey} size={28} />
          <span className="ma-meeting-speakers__name">{speaker.displayName}</span>
          {editingId === speaker.speakerId ? (
            <SpeakerLabelEditor
              roomId={roomId}
              meetingId={meetingId}
              speakerId={speaker.speakerId}
              currentDisplayName={speaker.displayName}
              profiles={profiles}
              onUpdated={(result) => {
                setEditingId(null);
                onRelabeled(speaker.speakerId, result.displayName);
              }}
            />
          ) : (
            <button type="button" className="ma-meeting-speakers__edit" onClick={() => setEditingId(speaker.speakerId)}>
              {t('detail.editSpeaker')}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
