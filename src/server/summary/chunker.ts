/**
 * Splits a meeting's `Segment[]` into map-pass windows for the summarizer
 * (plan.md § Architecture). Cuts at the nearest SEGMENT boundary to the
 * `windowSec` mark (never mid-sentence), then — because a single window's
 * rendered text can still exceed Hub AI's `PROMPT_LIMIT` (a dense window with
 * very long segments) — a second pass splits any over-budget window further,
 * again only at segment boundaries. Every final chunk is re-indexed
 * sequentially (`0..n-1`), so a caller never has to reconcile a "logical"
 * window index against a "physical" chunk index.
 */
import type { Segment } from '../transcript/segment-builder.js';
import { PROMPT_LIMIT } from '../hub/hub-ai-client.js';
import { sanitizeDisplayName } from './sanitize.js';

export interface TranscriptChunk {
  index: number;
  startSec: number;
  endSec: number;
  text: string;
  segmentCount: number;
}

export interface ChunkTranscriptOptions {
  windowSec?: number;
  maxSegments?: number;
  /** Reserved characters for the map prompt's own scaffolding (instructions, rolling context) around the chunk text — the chunk body itself is capped at `PROMPT_LIMIT - promptOverheadChars`. */
  promptOverheadChars?: number;
}

const DEFAULT_WINDOW_SEC = 720; // 12 minutes
const DEFAULT_MAX_SEGMENTS = 900;
const DEFAULT_PROMPT_OVERHEAD_CHARS = 4_000;

function formatTimestamp(totalSec: number): string {
  const sec = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
}

function segmentLine(segment: Segment, names: Record<string, string>): string {
  const name = sanitizeDisplayName(names[segment.speakerId] ?? segment.speakerId);
  return `[${formatTimestamp(segment.startSec)}] ${name}: ${segment.text}`;
}

interface Window {
  segments: Segment[];
}

/** First pass: greedily group segments into ~`windowSec` windows, never exceeding `maxSegments`. */
function windowBySegments(segments: readonly Segment[], windowSec: number, maxSegments: number): Window[] {
  if (segments.length === 0) return [];
  const windows: Window[] = [];
  let current: Segment[] = [];
  let windowStart = segments[0].startSec;

  for (const segment of segments) {
    const wouldExceedTime = current.length > 0 && segment.startSec - windowStart >= windowSec;
    const wouldExceedCount = current.length >= maxSegments;
    if (wouldExceedTime || wouldExceedCount) {
      windows.push({ segments: current });
      current = [];
      windowStart = segment.startSec;
    }
    current.push(segment);
  }
  if (current.length > 0) windows.push({ segments: current });
  return windows;
}

/** Second pass: split one window's segments further so its rendered text budget stays under `maxTextChars`. */
function splitByCharBudget(segments: readonly Segment[], names: Record<string, string>, maxTextChars: number): Segment[][] {
  const groups: Segment[][] = [];
  let current: Segment[] = [];
  let currentChars = 0;

  for (const segment of segments) {
    const lineChars = segmentLine(segment, names).length + 1; // +1 newline
    if (current.length > 0 && currentChars + lineChars > maxTextChars) {
      groups.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(segment);
    currentChars += lineChars;
  }
  if (current.length > 0) groups.push(current);
  return groups.length > 0 ? groups : [[]];
}

function toChunk(index: number, segments: readonly Segment[], names: Record<string, string>): TranscriptChunk {
  const startSec = segments[0]?.startSec ?? 0;
  const endSec = segments[segments.length - 1]?.endSec ?? startSec;
  return {
    index,
    startSec,
    endSec,
    text: segments.map((s) => segmentLine(s, names)).join('\n'),
    segmentCount: segments.length,
  };
}

export function chunkTranscript(
  segments: readonly Segment[],
  names: Record<string, string>,
  opts: ChunkTranscriptOptions = {},
): TranscriptChunk[] {
  const windowSec = opts.windowSec ?? DEFAULT_WINDOW_SEC;
  const maxSegments = opts.maxSegments ?? DEFAULT_MAX_SEGMENTS;
  const overhead = opts.promptOverheadChars ?? DEFAULT_PROMPT_OVERHEAD_CHARS;
  const maxTextChars = Math.max(1_000, PROMPT_LIMIT - overhead);

  const windows = windowBySegments(segments, windowSec, maxSegments);
  const chunks: TranscriptChunk[] = [];
  for (const window of windows) {
    const groups = splitByCharBudget(window.segments, names, maxTextChars);
    for (const group of groups) {
      if (group.length === 0) continue;
      chunks.push(toChunk(chunks.length, group, names));
    }
  }
  return chunks;
}
