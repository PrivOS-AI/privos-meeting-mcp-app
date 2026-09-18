/**
 * Map-reduce summarizer — the ONLY summarization path (QĐ-07, Hub AI via the
 * installation bot). Map pass: one Hub AI call per chunk, producing short
 * notes + decisions + action items. Reduce pass: one call combining every
 * chunk's notes into the final structured summary.
 *
 * OPEN QUESTION — map concurrency vs rolling context: plan.md's Architecture
 * section asks for BOTH "map song song tối đa 3 request giữ thứ tự" AND
 * "rolling context = notes chunk liền trước" (the immediately preceding
 * chunk's own notes). Those two are in tension — chunk i's rolling context is
 * only available once chunk i-1's call has actually completed, which forces a
 * dependency chain. This implementation keeps the ACCURACY requirement (a
 * real, completed previous-chunk context) and processes chunks sequentially;
 * "up to 3 concurrent" is deferred as a follow-up once/if the rolling-context
 * requirement is relaxed to "best-effort" (e.g. windowed context computed
 * ahead of time instead of depending on the live previous result).
 */
import { z } from 'zod';

import type { RoomBoundHubClient } from '@privos_ai/app-server';

import { AppError } from '../../shared/app-error.js';
import { generateAsyncWithHubAi } from '../hub/hub-ai-client.js';
import type { TranscriptChunk } from './chunker.js';
import { buildMapPrompt, buildReducePrompt, buildSchemaFixPrompt, SUMMARY_SYSTEM_CONTEXT, type SummaryLanguage } from './prompts.js';
import { sanitizeDisplayName } from './sanitize.js';

const actionItemSchema = z.object({
  task: z.string(),
  owner: z.string().nullable().default(null),
  due: z.string().nullable().default(null),
  at: z.number().nullable().default(null),
});

const chunkNotesSchema = z.object({
  notes: z.string(),
  decisions: z.array(z.string()).default([]),
  action_items: z.array(actionItemSchema).default([]),
});

export const summaryPayloadSchema = z.object({
  summary: z.string(),
  decisions: z.array(z.string()).default([]),
  action_items: z.array(actionItemSchema).default([]),
  key_topics: z.array(z.string()).default([]),
});

export type SummaryPayload = z.infer<typeof summaryPayloadSchema>;
type ChunkNotes = z.infer<typeof chunkNotesSchema>;

export interface SummarizeTranscriptInput {
  roomId: string;
  chunks: readonly TranscriptChunk[];
  language: SummaryLanguage;
  title: string;
  speakerNames: readonly string[];
}

const MAX_NETWORK_RETRIES = 2;
const NETWORK_RETRY_BASE_MS = 800;

function formatTimestamp(totalSec: number): string {
  const sec = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
}

/** Extract the first top-level JSON object from a Hub AI response — tolerant of stray prose/markdown fences around it. */
function extractJsonObject(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) throw new AppError('Hub AI trả về dữ liệu không đúng định dạng JSON.');
  return JSON.parse(text.slice(start, end + 1));
}

/** Calls Hub AI with up to `MAX_NETWORK_RETRIES` retries on transport/network failure (429s surface as thrown AppErrors from the client, same bucket). */
async function callWithNetworkRetry(hub: RoomBoundHubClient, roomId: string, prompt: string, signal?: AbortSignal): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_NETWORK_RETRIES; attempt++) {
    try {
      const { text } = await generateAsyncWithHubAi(hub, { roomId, prompt, systemContext: SUMMARY_SYSTEM_CONTEXT }, signal);
      return text;
    } catch (error) {
      lastError = error;
      if (attempt < MAX_NETWORK_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, NETWORK_RETRY_BASE_MS * (attempt + 1)));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new AppError(String(lastError));
}

/** One Hub AI call + zod validation, with exactly one "fix to schema" retry on a validation failure (plan.md). */
async function callAndValidate<S extends z.ZodTypeAny>(
  hub: RoomBoundHubClient,
  roomId: string,
  prompt: string,
  schema: S,
  schemaHint: string,
  signal?: AbortSignal,
): Promise<z.output<S>> {
  const first = await callWithNetworkRetry(hub, roomId, prompt, signal);
  const firstParsed = schema.safeParse(safeExtract(first));
  if (firstParsed.success) return firstParsed.data;

  const fixPrompt = buildSchemaFixPrompt(prompt, first, schemaHint);
  const second = await callWithNetworkRetry(hub, roomId, fixPrompt, signal);
  const secondParsed = schema.safeParse(safeExtract(second));
  if (secondParsed.success) return secondParsed.data;

  throw new AppError('Hub AI trả về JSON không đúng schema sau khi đã thử sửa lại.');
}

function safeExtract(text: string): unknown {
  try {
    return extractJsonObject(text);
  } catch {
    return undefined;
  }
}

const ACTION_ITEM_SCHEMA_HINT = '{"task": string, "owner": string|null, "due": string|null, "at": number|null}';
const NOTES_SCHEMA_HINT = `{"notes": string, "decisions": string[], "action_items": [${ACTION_ITEM_SCHEMA_HINT}]}`;
const SUMMARY_SCHEMA_HINT = `{"summary": string, "decisions": string[], "action_items": [${ACTION_ITEM_SCHEMA_HINT}], "key_topics": string[]}`;

/** Post-check: an `owner` must match a known speaker name OR be a free string ≤80 chars — otherwise it is unverifiable and dropped to `null` (plan.md § Requirements). */
function sanitizeOwner(owner: string | null, speakerNames: ReadonlySet<string>): string | null {
  if (!owner) return null;
  const trimmed = owner.trim();
  if (!trimmed) return null;
  if (speakerNames.has(trimmed)) return trimmed;
  if (trimmed.length <= 80) return trimmed;
  return null;
}

/** Runs the map pass (sequential — see module header) then the reduce pass, returning the final validated + post-checked payload. */
export async function summarizeTranscript(
  hub: RoomBoundHubClient,
  input: SummarizeTranscriptInput,
  signal?: AbortSignal,
): Promise<SummaryPayload> {
  if (input.chunks.length === 0) {
    throw new AppError('Không có nội dung transcript để tóm tắt.');
  }

  const notesByChunk: ChunkNotes[] = [];
  let rollingContext = '';
  for (const chunk of input.chunks) {
    const prompt = buildMapPrompt({
      index: chunk.index,
      total: input.chunks.length,
      startLabel: formatTimestamp(chunk.startSec),
      endLabel: formatTimestamp(chunk.endSec),
      rollingContext,
      chunkText: chunk.text,
    });
    const notes = await callAndValidate(hub, input.roomId, prompt, chunkNotesSchema, NOTES_SCHEMA_HINT, signal);
    notesByChunk.push(notes);
    // Rolling context = the immediately preceding chunk's own notes, capped ~400 words.
    rollingContext = notes.notes.split(/\s+/).slice(0, 400).join(' ');
  }

  const reducePrompt = buildReducePrompt({
    title: input.title,
    speakerNames: input.speakerNames,
    language: input.language,
    notesWithTimestamps: input.chunks.map((chunk, i) => ({
      startLabel: formatTimestamp(chunk.startSec),
      endLabel: formatTimestamp(chunk.endSec),
      notes: notesByChunk[i].notes,
      decisions: notesByChunk[i].decisions,
      actionItems: notesByChunk[i].action_items,
    })),
  });

  const reduced = await callAndValidate(hub, input.roomId, reducePrompt, summaryPayloadSchema, SUMMARY_SCHEMA_HINT, signal);

  const speakerNameSet = new Set(input.speakerNames.map((n) => sanitizeDisplayName(n)));
  return {
    ...reduced,
    action_items: reduced.action_items.map((item) => ({ ...item, owner: sanitizeOwner(item.owner, speakerNameSet) })),
  };
}
