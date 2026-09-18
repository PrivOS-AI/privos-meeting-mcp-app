/**
 * Batch translation of a meeting's stored `segments[]` via Hub AI
 * (`generateAsyncWithHubAi`) — used by `meeting-job.ts`'s translate step and
 * `meeting_summarize`'s re-run. Same "one Hub AI network, both live and batch"
 * rule as `meeting_translate` (QĐ-07/QĐ-12): batches by `PROMPT_LIMIT`,
 * skips segments already in the target language (`segment.lang === target`),
 * and — per plan.md § Requirements — a batch that errors is SKIPPED rather
 * than failing the whole translate step (those segments simply keep no
 * `translation`; the meeting still gets a usable summary).
 */
import type { RoomBoundHubClient } from '@privos_ai/app-server';

import type { Segment } from '../transcript/segment-builder.js';
import { generateAsyncWithHubAi, PROMPT_LIMIT } from '../hub/hub-ai-client.js';
import { buildBatchTranslatePrompt, type SummaryLanguage } from './prompts.js';

/** Reserve headroom for the prompt's own scaffolding around the JSON payload. */
const PROMPT_OVERHEAD_CHARS = 2_000;
const MAX_BATCH_CHARS = Math.max(1_000, PROMPT_LIMIT - PROMPT_OVERHEAD_CHARS);

export interface TranslateSegmentsInput {
  roomId: string;
  segments: readonly Segment[];
  target: SummaryLanguage;
  signal?: AbortSignal;
}

interface BatchItem {
  id: string;
  text: string;
}

function batchByCharBudget(items: readonly BatchItem[], maxChars: number): BatchItem[][] {
  const batches: BatchItem[][] = [];
  let current: BatchItem[] = [];
  let currentChars = 0;
  for (const item of items) {
    const itemChars = item.text.length + item.id.length + 8;
    if (current.length > 0 && currentChars + itemChars > maxChars) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(item);
    currentChars += itemChars;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function parseTranslationResponse(text: string, requestedIds: ReadonlySet<string>): Map<string, string> {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return new Map();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return new Map();
  }
  if (!Array.isArray(parsed)) return new Map();

  const out = new Map<string, string>();
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const id = (item as Record<string, unknown>).id;
    const translatedText = (item as Record<string, unknown>).text;
    if (typeof id === 'string' && typeof translatedText === 'string' && requestedIds.has(id) && !out.has(id)) {
      out.set(id, translatedText);
    }
  }
  return out;
}

/**
 * Translates every segment whose `lang` differs from `target`, batching calls
 * to stay under `PROMPT_LIMIT`. Returns `segmentId -> translation`; a failed
 * batch is logged and skipped (its segments end up absent from the map, i.e.
 * left untranslated) rather than aborting the whole pass.
 */
export async function translateSegmentsBatch(hub: RoomBoundHubClient, input: TranslateSegmentsInput): Promise<Map<string, string>> {
  const toTranslate: BatchItem[] = input.segments
    .filter((s) => s.lang !== input.target && s.text.trim())
    .map((s) => ({ id: s.id, text: s.text }));
  if (toTranslate.length === 0) return new Map();

  const batches = batchByCharBudget(toTranslate, MAX_BATCH_CHARS);
  const result = new Map<string, string>();

  for (const batch of batches) {
    try {
      const prompt = buildBatchTranslatePrompt(input.target, batch);
      const { text } = await generateAsyncWithHubAi(hub, { roomId: input.roomId, prompt }, input.signal);
      const requestedIds = new Set(batch.map((b) => b.id));
      for (const [id, translation] of parseTranslationResponse(text, requestedIds)) {
        result.set(id, translation);
      }
    } catch (error) {
      console.warn('[translator] bỏ qua một lô dịch lỗi:', error instanceof Error ? error.message : error);
    }
  }
  return result;
}
