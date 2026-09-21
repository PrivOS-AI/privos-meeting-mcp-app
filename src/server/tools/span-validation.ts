/**
 * Span-validation logic shared by `chunk-ready-tool.ts` (synchronous,
 * structural checks only — no audio yet) and `live-speakers/chunk-worker.ts`
 * (the part-window + silence checks, once PCM is actually decoded). Every
 * rejection here is a security-relevant event — a client sending
 * fabricated/hostile spans to try to attribute audio to the wrong person
 * (S2-05) — so callers log what got dropped and why.
 */
import { hasSpeechEnergy } from '../speaker/pcm-utils.js';

/** Generous ceiling on turns per ~60s part — guards against a malformed/hostile payload. */
export const MAX_SEGMENTS_PER_CHUNK = 200;

/** Edges may miss the server-tracked part window by up to this much (clock rounding, D-17). */
export const PART_WINDOW_TOLERANCE_MS = 1500;

export interface ChunkSegment {
  speaker: string;
  startMs: number;
  endMs: number;
  final: boolean;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Parses one raw `segments[]` entry, or `null` when its shape is invalid. */
export function asChunkSegment(value: unknown): ChunkSegment | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const speaker = asString(raw.speaker);
  const startMs = Number(raw.startMs);
  const endMs = Number(raw.endMs);
  if (!speaker || !Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 || startMs >= endMs) return null;
  return { speaker, startMs, endMs, final: raw.final === true };
}

/**
 * Structural checks that do not need audio or a server-tracked clock: cap on
 * turn count, no two turns of the SAME speaker overlapping, and total claimed
 * speech time not wildly exceeding the part's own declared `durationMs`
 * (anti-abuse bound, not a precise physical claim — legitimate turns from
 * different simultaneous speakers can overlap a little, hence the
 * tolerance). Throws `message` via the caller on any violation; a malformed
 * payload rejects the WHOLE call rather than silently dropping segments,
 * matching the P2 contract this phase keeps.
 */
export function assertStructuralSpans(segments: readonly ChunkSegment[], durationMs: number): string | null {
  if (segments.length > MAX_SEGMENTS_PER_CHUNK) return 'Too many turns in one recording part.';

  const bySpeaker = new Map<string, ChunkSegment[]>();
  let totalDurationMs = 0;
  for (const seg of segments) {
    totalDurationMs += seg.endMs - seg.startMs;
    const list = bySpeaker.get(seg.speaker) ?? [];
    list.push(seg);
    bySpeaker.set(seg.speaker, list);
  }
  for (const list of bySpeaker.values()) {
    const sorted = [...list].sort((a, b) => a.startMs - b.startMs);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].startMs < sorted[i - 1].endMs) return 'Two turns from the same speaker overlap in time.';
    }
  }
  if (totalDurationMs > durationMs + PART_WINDOW_TOLERANCE_MS) return 'Total turn duration exceeds the recording part.';
  return null;
}

/**
 * True when `seg.startMs` (meeting-clock ms) falls inside this part's REAL
 * window `[partStartMs, partStartMs + durationMs]` ± tolerance — the
 * server-tracked window (`MeetingSessionRegistry.decodedSecBefore`), never
 * the client's own claim. `endMs` is intentionally NOT bounded here — a turn
 * that legitimately runs past the window is deferred to the next chunk
 * (S2-03), not rejected.
 */
export function isWithinPartWindow(seg: Pick<ChunkSegment, 'startMs'>, partStartMs: number, durationMs: number): boolean {
  return seg.startMs >= partStartMs - PART_WINDOW_TOLERANCE_MS && seg.startMs <= partStartMs + durationMs + PART_WINDOW_TOLERANCE_MS;
}

/**
 * RMS-energy silence gate (plan.md open question #9 — Silero/`sherpa_onnx.Vad`
 * deferred until CPU measurements from real traffic justify it; RMS is the
 * documented default). A span whose audio never actually carries speech
 * energy is dropped rather than embedded — it cannot point to a real voice.
 */
export function hasRealEnergy(pcm: Float32Array): boolean {
  return hasSpeechEnergy(pcm);
}

/**
 * Generous ceiling on one part's declared wall span — twice the recorder's
 * ~60s timeslice, to tolerate a slow/backgrounded tab without accepting a
 * fabricated value.
 */
export const MAX_PART_DURATION_MS = 120_000;

/** Same tolerance as `PART_WINDOW_TOLERANCE_MS` (clock rounding, not a hostile gap). */
export const PART_STAMP_TOLERANCE_MS = PART_WINDOW_TOLERANCE_MS;

export interface PartStamp {
  seq: number;
  /** Absolute part-boundary stamp on the recorder's clock — `performance.now() - recorderEpochMs` at blob-emit time. */
  partStartMs: number;
  durationMs: number;
}

/**
 * Validates a NEW client's absolute per-part stamp: the client stamps every
 * part boundary at blob-emit time and sends it as-is, so the server never
 * sums durations itself to find where a part starts (that summing is exactly
 * what let upload latency shift every slice — the bug this stamp fixes).
 *
 * `previous` is the last stamp this meeting's registry accepted, or `null`
 * for the very first part it has ever validated — including right after a
 * restart/eviction rebuilt the registry from scratch, since this tracking is
 * in-memory only and never persisted. With no previous stamp to compare
 * against, only the bounds check applies (restart-safe by construction).
 *
 * Returns a violation reason, or `null` when the stamp is trustworthy enough
 * to slice audio against. Never clamps a bad value — the caller skips the
 * whole part instead of guessing a corrected position.
 */
export function validatePartStamp(current: PartStamp, previous: PartStamp | null): string | null {
  if (!Number.isFinite(current.partStartMs) || current.partStartMs < 0) return 'partStartMs must be a finite number >= 0.';
  if (!Number.isFinite(current.durationMs) || current.durationMs > MAX_PART_DURATION_MS) return 'durationMs exceeds the maximum allowed part length.';
  if (!previous) return null;
  if (current.partStartMs < previous.partStartMs) return 'partStartMs moved backward from the previous part (not monotonic).';
  if (current.seq === previous.seq + 1) {
    const expected = previous.partStartMs + previous.durationMs;
    if (Math.abs(current.partStartMs - expected) > PART_STAMP_TOLERANCE_MS) {
      return 'partStartMs is not within tolerance of the previous part boundary.';
    }
  }
  return null;
}
