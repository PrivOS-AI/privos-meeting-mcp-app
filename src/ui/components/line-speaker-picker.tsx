/**
 * Per-segment speaker picker (design 1a): the diarizer mixes voices up, so the
 * speaker name on every caption line opens this menu to say who really spoke
 * that segment. Opening it focuses the search box: type to filter the known
 * speakers, or press the Add button beside it to create a new person with the
 * typed name. "Apply to every line of this voice" moves the whole diarized
 * voice instead of just this line.
 */
import { useMemo, useState } from 'react';

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
  /** Add a new speaker named `name` (empty → unnamed) and move this line onto them. */
  onAddSpeaker(name: string, applyToVoice: boolean): void;
  onClose(): void;
}

export function LineSpeakerPicker({ speakers, currentKey, onPick, onRename, onAddSpeaker, onClose }: LineSpeakerPickerProps) {
  const { t } = useI18n();
  const [applyToVoice, setApplyToVoice] = useState(false);
  const [query, setQuery] = useState('');

  const trimmed = query.trim();
  const filtered = useMemo(
    () => (trimmed ? speakers.filter((s) => s.label.toLowerCase().includes(trimmed.toLowerCase())) : speakers),
    [speakers, trimmed],
  );
  const exactMatch = filtered.find((s) => s.label.toLowerCase() === trimmed.toLowerCase());

  // Enter picks an exact name match if one exists, otherwise adds a new person.
  function submit(): void {
    if (exactMatch) onPick(exactMatch.speakerKey, applyToVoice);
    else if (trimmed) onAddSpeaker(trimmed, applyToVoice);
  }

  return (
    <>
      <button type="button" className="ma-line-picker__backdrop" aria-label={t('speaker.linePicker.close')} onClick={onClose} />
      <div className="ma-line-picker" role="menu" aria-label={t('speaker.linePicker.title')}>
        <form
          className="ma-line-picker__search"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <Icon name="search" size={14} />
          <input
            className="ma-line-picker__search-input"
            type="text"
            autoFocus
            value={query}
            maxLength={80}
            placeholder={t('speaker.linePicker.searchOrAdd')}
            aria-label={t('speaker.linePicker.searchOrAdd')}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button
            type="submit"
            className="ma-line-picker__add-btn"
            disabled={!trimmed || Boolean(exactMatch)}
            title={t('speaker.linePicker.add')}
          >
            <Icon name="add" size={14} />
            {t('speaker.linePicker.add')}
          </button>
        </form>

        <div className="ma-line-picker__list">
          {filtered.length === 0 ? (
            <p className="ma-line-picker__empty">{t('speaker.linePicker.noMatch')}</p>
          ) : (
            filtered.map((speaker) => (
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
            ))
          )}
        </div>

        <div className="ma-line-picker__divider" />
        <button type="button" role="menuitem" className="ma-line-picker__item" onClick={onRename}>
          <Icon name="edit" size={16} />
          <span className="ma-line-picker__name">{t('speaker.linePicker.rename')}</span>
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
