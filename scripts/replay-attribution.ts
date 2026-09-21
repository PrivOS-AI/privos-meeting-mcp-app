/**
 * Pure (no I/O) attribution scoring for `replay-meeting-speakers.ts` — split
 * out so the majority-vote/false-merge/false-split logic is unit-testable
 * without decoding audio or running the speaker-embedding model.
 */
import type { CalibrationLabels } from './calibration-labels.js';

/** `"audio.part-0007-ab12cd34.webm"` -> `7`, or `null` for a name that does not match the production naming (`meeting-slug.ts#partFileName`). */
const PART_NAME_RE = /^audio\.part-(\d+)-.*\.webm$/i;

export function parsePartSeq(filename: string): number | null {
  const match = PART_NAME_RE.exec(filename);
  return match ? Number(match[1]) : null;
}

export interface ObserveEventLike {
  type: 'observe';
  label: string;
  startMs: number;
  targetId: string;
}

export interface AttributionReport {
  totalLabeledTurns: number;
  correctTurns: number;
  accuracy: number;
  /** Each entry is one REPLAY speaker's set of true people (>1 means turns from different people were folded together — a false merge), sorted by how many turns each contributed. */
  falseMergedPeople: string[][];
  /** True people whose turns landed in more than one (never-merged) replay speaker — a false split. */
  falseSplitPeople: string[];
}

/**
 * Two-hop ground-truth resolution: `observeEvents` (the ORIGINAL run's own
 * `targetId` per `label:startMs` turn) joined through `labels.json`'s
 * `sessionSpeakerId -> person` map (honoring `excludeTurns`/`overrideTurns`,
 * both keyed by the ORIGINAL `targetId`) — never the replay's own
 * (unrelated, freshly generated) session-speaker ids.
 */
export function resolveTruePersonByTurnKey(observeEvents: readonly ObserveEventLike[], labels: CalibrationLabels): Map<string, string> {
  const excludeSet = new Set(labels.excludeTurns ?? []);
  const overrides = labels.overrideTurns ?? {};
  const truePersonByTurnKey = new Map<string, string>();
  for (const e of observeEvents) {
    const originalKey = `${e.targetId}:${e.startMs}`;
    if (excludeSet.has(originalKey)) continue;
    const person = overrides[originalKey] ?? labels.speakers[e.targetId];
    if (person) truePersonByTurnKey.set(`${e.label}:${e.startMs}`, person);
  }
  return truePersonByTurnKey;
}

/**
 * Majority-vote attribution scoring: each REPLAY session speaker's "resolved
 * identity" is whichever true person contributed the most of its labeled
 * turns; a turn is correct when its own true person matches that majority. A
 * replay speaker whose turns span >1 true person is a FALSE MERGE; a true
 * person whose turns span >1 (never-merged) replay speaker is a FALSE SPLIT —
 * the same diarization-error-rate methodology
 * `calibrate-speaker-threshold.ts --session`'s false-merge/false-split table
 * uses, just measured end-to-end through the real registry instead of raw
 * pairwise cosines.
 */
export function computeAttributionReport(replayTargetByTurnKey: ReadonlyMap<string, string>, truePersonByTurnKey: ReadonlyMap<string, string>): AttributionReport {
  const byReplaySpeaker = new Map<string, Map<string, number>>();
  let totalLabeledTurns = 0;
  for (const [turnKey, replayTargetId] of replayTargetByTurnKey) {
    const person = truePersonByTurnKey.get(turnKey);
    if (!person) continue;
    totalLabeledTurns++;
    const counts = byReplaySpeaker.get(replayTargetId) ?? new Map<string, number>();
    counts.set(person, (counts.get(person) ?? 0) + 1);
    byReplaySpeaker.set(replayTargetId, counts);
  }

  const majorityByReplaySpeaker = new Map<string, string>();
  const falseMergedPeople: string[][] = [];
  for (const [replaySpeakerId, counts] of byReplaySpeaker) {
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    majorityByReplaySpeaker.set(replaySpeakerId, sorted[0][0]);
    if (sorted.length > 1) falseMergedPeople.push(sorted.map(([person]) => person));
  }

  let correctTurns = 0;
  for (const [turnKey, replayTargetId] of replayTargetByTurnKey) {
    const person = truePersonByTurnKey.get(turnKey);
    if (person && majorityByReplaySpeaker.get(replayTargetId) === person) correctTurns++;
  }

  const replaySpeakersByPerson = new Map<string, Set<string>>();
  for (const [replaySpeakerId, majority] of majorityByReplaySpeaker) {
    const set = replaySpeakersByPerson.get(majority) ?? new Set<string>();
    set.add(replaySpeakerId);
    replaySpeakersByPerson.set(majority, set);
  }
  const falseSplitPeople = [...replaySpeakersByPerson.entries()].filter(([, set]) => set.size > 1).map(([person]) => person);

  return {
    totalLabeledTurns,
    correctTurns,
    accuracy: totalLabeledTurns > 0 ? correctTurns / totalLabeledTurns : 0,
    falseMergedPeople,
    falseSplitPeople,
  };
}
