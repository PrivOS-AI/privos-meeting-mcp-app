/**
 * One transcript row: avatar + speaker name (colored by `colorKey`) + mm:ss +
 * text, click-to-seek, active-line highlight, search-hit highlighting and an
 * optional bilingual translation line (phase-07 § Requirements).
 *
 * Speaker names render as plain React text nodes (never
 * `dangerouslySetInnerHTML`/a markdown renderer), so they are inherently
 * "escaped" against markdown/HTML injection — the phase's "escape markdown
 * khi render" requirement is satisfied by construction, not by a separate
 * escaping step (that step already happened once, at `.md`/chat render time
 * server-side — see `sanitize.ts#escapeMarkdown`).
 */
import type { ReactNode } from 'react';

import { foldDiacritics } from '../data/keyword-search.js';
import { formatClock } from '../data/format-time.js';
import { SpeakerAvatar } from './speaker-avatar.js';

export interface TranscriptLineData {
  id: string;
  speakerId: string;
  startSec: number;
  text: string;
  translation?: string;
}

export interface TranscriptLineProps {
  segment: TranscriptLineData;
  speakerName: string;
  colorKey: string;
  active: boolean;
  showTranslation: boolean;
  highlightQuery?: string;
  onSeek(sec: number): void;
}

/** Wraps every diacritic-insensitive match of `query` in a `<mark>` — reuses `foldDiacritics`'s 1:1 length guarantee (see keyword-search.ts header) to map fold offsets back onto the original text. */
function renderHighlighted(text: string, query: string): ReactNode[] {
  const needle = foldDiacritics(query.trim().toLowerCase());
  if (!needle) return [text];
  const haystack = foldDiacritics(text.toLowerCase());
  const parts: ReactNode[] = [];
  let last = 0;
  let index = haystack.indexOf(needle);
  let key = 0;
  while (index !== -1) {
    if (index > last) parts.push(text.slice(last, index));
    parts.push(
      <mark key={key++} className="ma-transcript-line__mark">
        {text.slice(index, index + needle.length)}
      </mark>,
    );
    last = index + needle.length;
    index = haystack.indexOf(needle, last);
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

export function TranscriptLine({ segment, speakerName, colorKey, active, showTranslation, highlightQuery, onSeek }: TranscriptLineProps) {
  return (
    <div
      className={`ma-transcript-line${active ? ' ma-transcript-line--active' : ''}`}
      onClick={() => onSeek(segment.startSec)}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') onSeek(segment.startSec);
      }}
    >
      <SpeakerAvatar name={speakerName} colorKey={colorKey} size={28} />
      <div className="ma-transcript-line__body">
        <div className="ma-transcript-line__meta">
          <strong className={`ma-transcript-line__name ma-transcript-line__name--${colorKey}`}>{speakerName}</strong>
          <span className="ma-transcript-line__time">{formatClock(segment.startSec)}</span>
        </div>
        <p className="ma-transcript-line__text">{highlightQuery ? renderHighlighted(segment.text, highlightQuery) : segment.text}</p>
        {showTranslation && segment.translation ? <p className="ma-transcript-line__translation">{segment.translation}</p> : null}
      </div>
    </div>
  );
}
