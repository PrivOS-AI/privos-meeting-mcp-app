/**
 * The ONE `labels.json` shape both `extract-calibration-slices.ts` (cutting
 * clips) and `replay-meeting-speakers.ts` (scoring attribution) read — split
 * out so the two scripts share a single parser instead of two independently
 * drifting copies.
 *
 * `sessionSpeakerId -> person` is the id->person map, held SEPARATE from
 * whatever a script does with it (a clip corpus, an accuracy report) — see
 * each consumer's own header for its biometric-handling note.
 * `excludeTurns`/`overrideTurns` are keyed by {@link turnKey}`(targetId,
 * startMs)` — exactly the pair a human sees when listening back to the kept
 * audio at a turn's own `startMs` for a given `targetId` (session speaker).
 */
import { readFile } from 'node:fs/promises';

export interface CalibrationLabels {
  speakers: Record<string, string>;
  excludeTurns?: string[];
  overrideTurns?: Record<string, string>;
}

/** `(targetId, startMs)` -> the turn key `excludeTurns`/`overrideTurns` use. */
export function turnKey(targetId: string, startMs: number): string {
  return `${targetId}:${startMs}`;
}

/** Parses + validates a `labels.json` file, defaulting the optional arrays/maps to empty. Throws when "speakers" is missing/not an object. */
export async function readCalibrationLabels(labelsPath: string): Promise<CalibrationLabels> {
  const raw = await readFile(labelsPath, 'utf8');
  const parsed = JSON.parse(raw) as Partial<CalibrationLabels>;
  if (!parsed.speakers || typeof parsed.speakers !== 'object') {
    throw new Error(`"${labelsPath}" must have a "speakers" object mapping sessionSpeakerId -> person name.`);
  }
  return { speakers: parsed.speakers, excludeTurns: parsed.excludeTurns ?? [], overrideTurns: parsed.overrideTurns ?? {} };
}
