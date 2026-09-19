/**
 * Per-segment speaker picker (design 1a): the diarizer mixes voices up, so the
 * speaker name on every caption line opens this menu to say who really spoke
 * that segment — pick a known speaker, rename the current one, or add a new
 * speaker. "Apply to every line of this voice" moves the whole diarized voice
 * instead of just this line.
 */
import { useState } from 'react';

import { useI18n } from '../i18n/i18n-provider.js';
import { Icon } from './icon.js';
import { SpeakerAvatar } from './speaker-avatar.js';

export interface PickerSpeaker {
  speakerKey: string;
  label: string;
  colorKey: string;
}

export interface LineSpeakerPickerProps {
  speakers: readonly PickerSpeaker[];
  currentKey?: string;
  onPick(speakerKey: string, applyToVoice: boolean): void;
  onRename(): void;
  onAddSpeaker(applyToVoice: boolean): void;
  onClose(): void;
}

export function LineSpeakerPicker({ speakers, currentKey, onPick, onRename, onAddSpeaker, onClose }: LineSpeakerPickerProps) {
  const { t } = useI18n();
  const [applyToVoice, setApplyToVoice] = useState(false);

  return (
    <>
      <button type="button" className="ma-line-picker__backdrop" aria-label={t('speaker.linePicker.close')} onClick={onClose} />
      <div className="ma-line-picker" role="menu" aria-label={t('speaker.linePicker.title')}>
        {speakers.map((speaker) => (
          <button
            key={speaker.speakerKey}
            type="button"
            role="menuitemradio"
            aria-checked={speaker.speakerKey === currentKey}
            className={`ma-line-picker__item${speaker.speakerKey === currentKey ? ' ma-line-picker__item--current' : ''}`}
            onClick={() => onPick(speaker.speakerKey, applyToVoice)}
          >
            <SpeakerAvatar name={speaker.label} colorKey={speaker.colorKey} size={24} />
            <span className="ma-line-picker__name">{speaker.label}</span>
            {speaker.speakerKey === currentKey ? <Icon name="checkmark" size={16} /> : null}
          </button>
        ))}
        <div className="ma-line-picker__divider" />
        <button type="button" role="menuitem" className="ma-line-picker__item" onClick={onRename}>
          <Icon name="edit" size={16} />
          <span className="ma-line-picker__name">{t('speaker.linePicker.rename')}</span>
        </button>
        <button type="button" role="menuitem" className="ma-line-picker__item" onClick={() => onAddSpeaker(applyToVoice)}>
          <Icon name="add" size={16} />
          <span className="ma-line-picker__name">{t('speaker.linePicker.addSpeaker')}</span>
        </button>
        <div className="ma-line-picker__divider" />
        <label className="ma-line-picker__apply">
          <span>{t('speaker.linePicker.applyToVoice')}</span>
          <input type="checkbox" role="switch" checked={applyToVoice} onChange={(e) => setApplyToVoice(e.target.checked)} />
        </label>
      </div>
    </>
  );
}
