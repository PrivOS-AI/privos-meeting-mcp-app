/**
 * `transcript.srt` — one cue per segment; a segment longer than
 * `MAX_CUE_SEC` is split at token boundaries into evenly-sized cues instead
 * of one giant subtitle.
 */
import type { Segment } from './segment-builder.js';
import type { SttToken } from '../stt/stt-provider.js';

const MAX_CUE_SEC = 7;

interface Cue {
  startSec: number;
  endSec: number;
  text: string;
}

function srtTimestamp(totalSec: number): string {
  const totalMs = Math.max(0, Math.round(totalSec * 1000));
  const h = Math.floor(totalMs / 3_600_000);
  const m = Math.floor((totalMs % 3_600_000) / 60_000);
  const s = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

function joinCueText(tokens: readonly SttToken[]): string {
  return tokens
    .map((t) => t.text)
    .join(' ')
    .replace(/\s+([,.!?;:])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Split one long segment into `MAX_CUE_SEC`-ish chunks at the nearest token boundary. */
function splitSegment(segment: Segment, tokens: readonly SttToken[]): Cue[] {
  const durationSec = segment.endSec - segment.startSec;
  if (durationSec <= MAX_CUE_SEC) {
    return [{ startSec: segment.startSec, endSec: segment.endSec, text: segment.text }];
  }

  const segmentTokens = tokens.filter(
    (t) => t.startMs / 1000 >= segment.startSec - 0.001 && t.endMs / 1000 <= segment.endSec + 0.001,
  );
  if (segmentTokens.length === 0) {
    return [{ startSec: segment.startSec, endSec: segment.endSec, text: segment.text }];
  }

  const chunkCount = Math.ceil(durationSec / MAX_CUE_SEC);
  const targetSec = durationSec / chunkCount;
  const cues: Cue[] = [];
  let bucket: SttToken[] = [];
  let nextBoundarySec = segment.startSec + targetSec;

  for (const token of segmentTokens) {
    bucket.push(token);
    if (token.endMs / 1000 >= nextBoundarySec && cues.length < chunkCount - 1) {
      cues.push({ startSec: bucket[0].startMs / 1000, endSec: token.endMs / 1000, text: joinCueText(bucket) });
      bucket = [];
      nextBoundarySec += targetSec;
    }
  }
  if (bucket.length > 0) {
    cues.push({ startSec: bucket[0].startMs / 1000, endSec: segment.endSec, text: joinCueText(bucket) });
  }
  return cues.length > 0 ? cues : [{ startSec: segment.startSec, endSec: segment.endSec, text: segment.text }];
}

export function buildSrt(segments: readonly Segment[], tokens: readonly SttToken[] = []): string {
  const cues: Cue[] = [];
  for (const segment of segments) cues.push(...splitSegment(segment, tokens));
  return cues.map((cue, index) => `${index + 1}\n${srtTimestamp(cue.startSec)} --> ${srtTimestamp(cue.endSec)}\n${cue.text}\n`).join('\n');
}
