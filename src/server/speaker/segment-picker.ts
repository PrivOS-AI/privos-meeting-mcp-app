/**
 * Picks which transcript segments to spend an embedding pass on for each
 * speaker, before `resolve-speakers.ts` cuts PCM and calls the extractor
 * (plan.md § Backend — pick enrolment segment). Prefers longer, higher-confidence
 * segments so the resulting embedding is built from clean speech rather than
 * short interjections.
 */
import type { Segment } from '../transcript/segment-builder.js';

export interface EnrolRange {
  startSec: number;
  endSec: number;
}

export interface EnrolPlan {
  speakerId: string;
  ranges: EnrolRange[];
  /** Sum of `ranges` duration — 0 with empty `ranges` means "too little clean data, skip". */
  totalSec: number;
  /** Total speaking time for this speaker across ALL segments (not just the picked ranges) — informational, for `JobResultSpeaker.totalSpeakSec`. */
  totalSpeakSec: number;
}

export interface PlanEnrolmentOptions {
  minSegSec: number;
  targetSec: number;
}

/** A segment is a candidate only if it clears the minimum duration and carries at least this many words — guards against a burst of short filler tokens masquerading as a long segment. */
const MIN_WORD_COUNT = 4;
/** Never pick more than this many ranges per speaker, however many candidates qualify — bounds both PCM-read cost and the number of small `readWavPcm` calls. */
const MAX_RANGES = 8;

function wordCount(text: string): number {
  return text.trim().length === 0 ? 0 : text.trim().split(/\s+/).length;
}

/**
 * Selects up to `MAX_RANGES` segments per speaker — longest & highest
 * `avgConfidence` first — until their combined duration reaches `targetSec`.
 * A speaker whose total picked duration stays under `2 * minSegSec` gets an
 * empty `ranges` (too little clean data to embed) even if they spoke a lot in
 * aggregate (e.g. many short interjections).
 */
export function planEnrolment(segments: readonly Segment[], options: PlanEnrolmentOptions): EnrolPlan[] {
  const { minSegSec, targetSec } = options;
  const bySpeaker = new Map<string, Segment[]>();
  const totalSpeakSecBySpeaker = new Map<string, number>();

  for (const seg of segments) {
    const duration = seg.endSec - seg.startSec;
    totalSpeakSecBySpeaker.set(seg.speakerId, (totalSpeakSecBySpeaker.get(seg.speakerId) ?? 0) + duration);
    if (duration < minSegSec || wordCount(seg.text) < MIN_WORD_COUNT) continue;
    const list = bySpeaker.get(seg.speakerId) ?? [];
    list.push(seg);
    bySpeaker.set(seg.speakerId, list);
  }

  const plans: EnrolPlan[] = [];
  for (const [speakerId, totalSpeakSec] of totalSpeakSecBySpeaker) {
    const candidates = [...(bySpeaker.get(speakerId) ?? [])].sort((a, b) => {
      const durA = a.endSec - a.startSec;
      const durB = b.endSec - b.startSec;
      if (durB !== durA) return durB - durA;
      return (b.avgConfidence ?? 0) - (a.avgConfidence ?? 0);
    });

    const ranges: EnrolRange[] = [];
    let totalSec = 0;
    for (const seg of candidates) {
      if (ranges.length >= MAX_RANGES) break;
      if (totalSec >= targetSec) break;
      ranges.push({ startSec: seg.startSec, endSec: seg.endSec });
      totalSec += seg.endSec - seg.startSec;
    }

    if (totalSec < minSegSec * 2) {
      plans.push({ speakerId, ranges: [], totalSec: 0, totalSpeakSec });
      continue;
    }
    plans.push({ speakerId, ranges, totalSec, totalSpeakSec });
  }

  return plans;
}
