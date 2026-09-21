/**
 * ONE segment builder for BOTH async providers — soniox-async and
 * elevenlabs-batch already normalize to the same `SttToken[]`, so there is
 * nothing provider-specific left here. Cuts a new segment when the speaker
 * changes, the language changes, or the gap since the same speaker's last
 * token exceeds `pauseSplitSec`; merges a segment shorter than
 * `minSegmentSec` into the previous one when they share a speaker; a token
 * missing `speaker` inherits the previous token's.
 */
import type { SttToken } from '../stt/stt-provider.js';

export interface Segment {
  id: string;
  speakerId: string;
  startSec: number;
  endSec: number;
  text: string;
  translation?: string;
  lang: string;
  tokenCount: number;
  avgConfidence?: number;
}

export interface BuildSegmentsOptions {
  pauseSplitSec?: number;
  /** Segments shorter than this merge into the previous same-speaker segment. */
  minSegmentSec?: number;
  /** Language used when a token has none and there is no prior segment to inherit from. */
  defaultLang?: string;
  /**
   * How each token's `text` already spaces itself. The two async providers use
   * OPPOSITE conventions, so joining must respect the source:
   *  - `false` (default): tokens are bare words (elevenlabs-batch drops its
   *    `spacing` tokens) → join with a single space.
   *  - `true`: tokens already carry their own inter-word spacing (soniox-async
   *    returns leading spaces / space tokens; subword tokens have none) →
   *    concatenate. Joining these with a space instead shreds every word into
   *    syllables, e.g. Vietnamese "lĩnh" → "l ĩ nh".
   */
  tokensCarrySpacing?: boolean;
}

const DEFAULT_PAUSE_SPLIT_SEC = 1.5;
const DEFAULT_MIN_SEGMENT_SEC = 0.3;
const DEFAULT_LANG = 'vi';

interface BuildingSegment {
  speakerId: string;
  lang: string;
  startMs: number;
  endMs: number;
  parts: string[];
  tokenCount: number;
  confSum: number;
  confCount: number;
  /** Per-language token counts, so the final `lang` is whichever language the MAJORITY of tokens used (D-12). */
  langCounts: Map<string, number>;
}

function majorityLang(counts: Map<string, number>, fallback: string): string {
  let best = fallback;
  let bestCount = -1;
  for (const [lang, count] of counts) {
    if (count > bestCount) {
      best = lang;
      bestCount = count;
    }
  }
  return best;
}

function joinTokenText(parts: readonly string[], carrySpacing: boolean): string {
  return (carrySpacing ? parts.join('') : parts.join(' '))
    .replace(/\s+([,.!?;:])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function buildSegments(tokens: readonly SttToken[], options: BuildSegmentsOptions = {}): Segment[] {
  const pauseSplitSec = options.pauseSplitSec ?? DEFAULT_PAUSE_SPLIT_SEC;
  const minSegmentSec = options.minSegmentSec ?? DEFAULT_MIN_SEGMENT_SEC;
  const defaultLang = options.defaultLang ?? DEFAULT_LANG;
  const tokensCarrySpacing = options.tokensCarrySpacing ?? false;
  if (tokens.length === 0) return [];

  let lastSpeaker: string | undefined;
  const raw: BuildingSegment[] = [];
  let current: BuildingSegment | null = null;

  for (const rawToken of tokens) {
    const speaker = rawToken.speaker ?? lastSpeaker ?? 'unknown';
    lastSpeaker = speaker;
    const lang: string = rawToken.language ?? current?.lang ?? defaultLang;

    const newSpeaker = !current || current.speakerId !== speaker;
    const pauseTooLong = current ? (rawToken.startMs - current.endMs) / 1000 > pauseSplitSec : false;
    const languageChanged = current ? current.lang !== lang : false;

    if (!current || newSpeaker || pauseTooLong || languageChanged) {
      current = {
        speakerId: speaker,
        lang,
        startMs: rawToken.startMs,
        endMs: rawToken.endMs,
        parts: [],
        tokenCount: 0,
        confSum: 0,
        confCount: 0,
        langCounts: new Map(),
      };
      raw.push(current);
    }

    current.endMs = Math.max(current.endMs, rawToken.endMs);
    if (rawToken.text) current.parts.push(rawToken.text);
    current.tokenCount += 1;
    if (typeof rawToken.confidence === 'number') {
      current.confSum += rawToken.confidence;
      current.confCount += 1;
    }
    const tokenLang = rawToken.language ?? lang;
    current.langCounts.set(tokenLang, (current.langCounts.get(tokenLang) ?? 0) + 1);
  }

  const merged: BuildingSegment[] = [];
  for (const seg of raw) {
    const durationSec = (seg.endMs - seg.startMs) / 1000;
    const prev = merged[merged.length - 1];
    if (durationSec < minSegmentSec && prev && prev.speakerId === seg.speakerId) {
      prev.endMs = Math.max(prev.endMs, seg.endMs);
      prev.parts.push(...seg.parts);
      prev.tokenCount += seg.tokenCount;
      prev.confSum += seg.confSum;
      prev.confCount += seg.confCount;
      for (const [lang, count] of seg.langCounts) prev.langCounts.set(lang, (prev.langCounts.get(lang) ?? 0) + count);
      continue;
    }
    merged.push(seg);
  }

  return merged.map((seg, index) => ({
    id: `seg-${index}`,
    speakerId: seg.speakerId,
    startSec: seg.startMs / 1000,
    endSec: seg.endMs / 1000,
    text: joinTokenText(seg.parts, tokensCarrySpacing),
    lang: majorityLang(seg.langCounts, seg.lang),
    tokenCount: seg.tokenCount,
    avgConfidence: seg.confCount > 0 ? seg.confSum / seg.confCount : undefined,
  }));
}
