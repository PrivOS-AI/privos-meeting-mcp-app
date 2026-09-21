/**
 * Meeting detail transcript controls (phase-07 § Requirements): keyword
 * search with ‹ › result navigation + "n/total" counter, multi-select
 * speaker filter, bilingual toggle (hidden when no segment has a
 * translation) and an auto-scroll toggle. Split out of
 * `meeting-detail-screen.tsx` to keep that screen under the repo's
 * ~200-line convention.
 */
import { useI18n } from '../i18n/i18n-provider.js';
import { Icon } from './icon.js';
import { SearchBox } from './search-box.js';

export interface TranscriptSpeakerOption {
  speakerId: string;
  displayName: string;
}

export interface TranscriptToolbarProps {
  query: string;
  onQueryChange(query: string): void;
  hitIndex: number;
  hitCount: number;
  onPrevHit(): void;
  onNextHit(): void;
  speakers: TranscriptSpeakerOption[];
  speakerFilter: ReadonlySet<string>;
  onToggleSpeaker(speakerId: string): void;
  hasTranslation: boolean;
  showTranslation: boolean;
  onToggleTranslation(): void;
  autoScroll: boolean;
  onToggleAutoScroll(): void;
}

export function TranscriptToolbar({
  query,
  onQueryChange,
  hitIndex,
  hitCount,
  onPrevHit,
  onNextHit,
  speakers,
  speakerFilter,
  onToggleSpeaker,
  hasTranslation,
  showTranslation,
  onToggleTranslation,
  autoScroll,
  onToggleAutoScroll,
}: TranscriptToolbarProps) {
  const { t } = useI18n();

  return (
    <div className="ma-transcript-toolbar">
      <div className="ma-transcript-toolbar__search">
        <SearchBox value={query} onChange={onQueryChange} placeholder={t('detail.searchPlaceholder')} />
        {query ? (
          <div className="ma-transcript-toolbar__nav">
            <button type="button" onClick={onPrevHit} disabled={hitCount === 0} aria-label={t('detail.searchPrev')}>
              <Icon name="chevron-right" size={14} className="ma-transcript-toolbar__prev-icon" />
            </button>
            <span>{hitCount === 0 ? '0/0' : `${hitIndex + 1}/${hitCount}`}</span>
            <button type="button" onClick={onNextHit} disabled={hitCount === 0} aria-label={t('detail.searchNext')}>
              <Icon name="chevron-right" size={14} />
            </button>
          </div>
        ) : null}
      </div>

      <div className="ma-transcript-toolbar__filters">
        <details className="ma-transcript-toolbar__speaker-filter">
          <summary>
            <Icon name="filter" size={14} /> {t('detail.filterBySpeaker')}
            {speakerFilter.size > 0 ? ` (${speakerFilter.size})` : ''}
          </summary>
          <ul>
            {speakers.map((speaker) => (
              <li key={speaker.speakerId}>
                <label>
                  <input type="checkbox" checked={speakerFilter.has(speaker.speakerId)} onChange={() => onToggleSpeaker(speaker.speakerId)} />
                  {speaker.displayName}
                </label>
              </li>
            ))}
          </ul>
        </details>

        {hasTranslation ? (
          <button type="button" className="ma-transcript-toolbar__toggle" aria-pressed={showTranslation} onClick={onToggleTranslation}>
            <Icon name="translate" size={14} /> {t('detail.showTranslation')}
          </button>
        ) : null}

        <button type="button" className="ma-transcript-toolbar__toggle" aria-pressed={autoScroll} onClick={onToggleAutoScroll}>
          {t('detail.autoScroll')}
        </button>
      </div>
    </div>
  );
}
