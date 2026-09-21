/**
 * Diacritic-insensitive keyword search (phase-07 § Architecture) — "hop"
 * must match "họp". `\p{Diacritic}` NFD-stripping folds every Latin
 * combining-mark accent to its base letter; Vietnamese đ/Đ is a standalone
 * codepoint that does not decompose under NFD, so it gets an explicit fold.
 *
 * Every precomposed accented letter this app's transcripts contain (Latin
 * base + combining marks, or đ/Đ) folds to exactly ONE base character, so a
 * folded string is always the same length as its source — hit offsets found
 * in the folded haystack map 1:1 back onto the original text used for `pre`/
 * `hit`/`post` slicing below.
 */
export interface TranscriptSegmentLike {
  id: string;
  startSec: number;
  text: string;
}

export interface Hit {
  segmentId: string;
  startSec: number;
  pre: string;
  hit: string;
  post: string;
}

export interface MeetingSearchRow {
  /** Not read by `searchMeetings` itself — optional so callers/tests can carry an id through without a cast. */
  id?: string;
  title?: string;
  summaryText?: string;
}

const CONTEXT_CHARS = 40;

export function foldDiacritics(input: string): string {
  return input
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D');
}

/** Every match of `query` inside every segment's text, diacritic- and case-insensitive. An empty/whitespace query returns no hits. */
export function searchTranscript(segments: readonly TranscriptSegmentLike[], query: string): Hit[] {
  const needle = foldDiacritics(query.trim().toLowerCase());
  if (!needle) return [];

  const hits: Hit[] = [];
  for (const segment of segments) {
    const haystack = foldDiacritics(segment.text.toLowerCase());
    let fromIndex = 0;
    while (fromIndex <= haystack.length) {
      const index = haystack.indexOf(needle, fromIndex);
      if (index === -1) break;
      hits.push({
        segmentId: segment.id,
        startSec: segment.startSec,
        pre: segment.text.slice(Math.max(0, index - CONTEXT_CHARS), index),
        hit: segment.text.slice(index, index + needle.length),
        post: segment.text.slice(index + needle.length, index + needle.length + CONTEXT_CHARS),
      });
      fromIndex = index + needle.length;
    }
  }
  return hits;
}

/** Meetings whose title or stored summary text contains `query`, diacritic- and case-insensitive. An empty query returns every row unfiltered (v1 = keyword-over-summary, no vector search — documented approximation). */
export function searchMeetings<T extends MeetingSearchRow>(rows: readonly T[], query: string): T[] {
  const needle = foldDiacritics(query.trim().toLowerCase());
  if (!needle) return [...rows];
  return rows.filter((row) => foldDiacritics(`${row.title ?? ''} ${row.summaryText ?? ''}`.toLowerCase()).includes(needle));
}
