/**
 * Map-reduce summarizer — the ONLY summarization path (D-07, Hub AI via the
 * installation bot). Map pass: one Hub AI call per chunk, producing short
 * notes + decisions + action items. Reduce pass: one call combining every
 * chunk's notes into the final structured summary.
 *
 * OPEN QUESTION — map concurrency vs rolling context: plan.md's Architecture
 * section asks for BOTH "map up to 3 requests in parallel, keeping order" AND
 * "rolling context = the immediately preceding chunk's own notes". Those two are in tension — chunk i's rolling context is
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
import { ACTION_ITEM_JSON, buildMapPrompt, buildReducePrompt, buildSchemaFixPrompt, DECISION_JSON, SUMMARY_SYSTEM_CONTEXT, type SummaryLanguage, type SummaryLength } from './prompts.js';
import { sanitizeDisplayName } from './sanitize.js';

export const ACTION_ITEM_TYPES = ['task', 'request', 'question'] as const;
export type ActionItemType = (typeof ACTION_ITEM_TYPES)[number];

const nullableString = z.string().nullable().default(null);

const actionItemSchema = z.object({
  // An unknown or missing type is a plain task rather than a failed summary.
  type: z.enum(ACTION_ITEM_TYPES).catch('task').default('task'),
  task: z.string(),
  owner: nullableString,
  requester: nullableString,
  due: nullableString,
  due_date: nullableString,
  at: z.number().nullable().default(null),
  quote: nullableString,
});

/** A decision: older replies (and short models) give a bare string, which becomes `{ text }`. */
const decisionSchema = z.union([
  z.string().transform((text) => ({ text, by: null as string | null, at: null as number | null })),
  z.object({ text: z.string(), by: nullableString, at: z.number().nullable().default(null) }),
]);

const chunkNotesSchema = z.object({
  notes: z.string(),
  decisions: z.array(decisionSchema).default([]),
  action_items: z.array(actionItemSchema).default([]),
});

export const summaryPayloadSchema = z.object({
  summary: z.string(),
  decisions: z.array(decisionSchema).default([]),
  action_items: z.array(actionItemSchema).default([]),
  key_topics: z.array(z.string()).default([]),
});

export type SummaryPayload = z.infer<typeof summaryPayloadSchema>;
export type SummaryActionItem = SummaryPayload['action_items'][number];
export type SummaryDecision = SummaryPayload['decisions'][number];
type ChunkNotes = z.infer<typeof chunkNotesSchema>;

export interface SummarizeTranscriptInput {
  roomId: string;
  chunks: readonly TranscriptChunk[];
  language: SummaryLanguage;
  /** The room's `summaryLength` setting; `normal` when unset. */
  length?: SummaryLength;
  title: string;
  speakerNames: readonly string[];
  /** YYYY-MM-DD the meeting took place, for turning "Friday" into a `due_date`. */
  meetingDate?: string;
  /** The recorder's notes, if any. */
  notes?: string;
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
  if (start === -1 || end === -1 || end < start) throw new AppError('Hub AI returned data that is not valid JSON.', 'HUB_ERROR');
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

  throw new AppError('Hub AI returned JSON that does not match the schema even after a retry.', 'HUB_ERROR');
}

function safeExtract(text: string): unknown {
  try {
    return extractJsonObject(text);
  } catch {
    return undefined;
  }
}

const NOTES_SCHEMA_HINT = `{"notes": string, "decisions": [${DECISION_JSON}], "action_items": [${ACTION_ITEM_JSON}]}`;
const SUMMARY_SCHEMA_HINT = `{"summary": string, "decisions": [${DECISION_JSON}], "action_items": [${ACTION_ITEM_JSON}], "key_topics": string[]}`;
const MAX_QUOTE_CHARS = 200;

/** Post-check: an `owner` must match a known speaker name OR be a free string ≤80 chars — otherwise it is unverifiable and dropped to `null` (plan.md § Requirements). */
function sanitizeOwner(owner: string | null, speakerNames: ReadonlySet<string>): string | null {
  if (!owner) return null;
  const trimmed = owner.trim();
  if (!trimmed) return null;
  if (speakerNames.has(trimmed)) return trimmed;
  if (trimmed.length <= 80) return trimmed;
  return null;
}

/** Lowercase, letters and digits only, single spaces — so a quote matches the transcript despite punctuation or spacing drift. */
function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** A quote is kept only when it really is in the transcript; the model may paraphrase or invent one. */
export function verifiedQuote(quote: string | null, normalizedTranscript: string): string | null {
  if (!quote) return null;
  const trimmed = quote.trim().slice(0, MAX_QUOTE_CHARS);
  const needle = normalizeForMatch(trimmed);
  return needle.length >= 3 && normalizedTranscript.includes(needle) ? trimmed : null;
}

/** A timestamp must fall inside the meeting. */
function verifiedAt(at: number | null, lastSec: number): number | null {
  return typeof at === 'number' && Number.isFinite(at) && at >= 0 && at <= lastSec + 5 ? Math.round(at) : null;
}

/** `YYYY-MM-DD` and a real calendar date, else null. */
export function verifiedDueDate(value: string | null): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : null;
}

/**
 * The post-checks every summary goes through before anything is stored: names must be speakers
 * (or short plain names), quotes must exist in the transcript, timestamps inside the meeting,
 * dates real. What fails a check becomes null — the item itself is kept.
 */
export function verifySummary(payload: SummaryPayload, chunks: readonly TranscriptChunk[], speakerNames: readonly string[]): SummaryPayload {
  const names = new Set(speakerNames.map((n) => sanitizeDisplayName(n)));
  const transcript = normalizeForMatch(chunks.map((c) => c.text).join('\n'));
  const lastSec = chunks.reduce((max, c) => Math.max(max, c.endSec), 0);
  return {
    ...payload,
    decisions: payload.decisions.map((d) => ({ text: d.text, by: sanitizeOwner(d.by, names), at: verifiedAt(d.at, lastSec) })),
    action_items: payload.action_items.map((item) => ({
      ...item,
      owner: sanitizeOwner(item.owner, names),
      requester: sanitizeOwner(item.requester, names),
      due: item.due?.trim() || null,
      due_date: verifiedDueDate(item.due_date),
      at: verifiedAt(item.at, lastSec),
      quote: verifiedQuote(item.quote, transcript),
    })),
  };
}

/** Runs the map pass (sequential — see module header) then the reduce pass, returning the final validated + post-checked payload. */
export async function summarizeTranscript(
  hub: RoomBoundHubClient,
  input: SummarizeTranscriptInput,
  signal?: AbortSignal,
): Promise<SummaryPayload> {
  if (input.chunks.length === 0) {
    throw new AppError('No speech was recognised in the recording, so there is nothing to summarize. Check that the right microphone is selected and not muted.', 'INVALID_STATE');
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
    length: input.length,
    meetingDate: input.meetingDate,
    notes: input.notes,
    notesWithTimestamps: input.chunks.map((chunk, i) => ({
      startLabel: formatTimestamp(chunk.startSec),
      endLabel: formatTimestamp(chunk.endSec),
      notes: notesByChunk[i].notes,
      decisions: notesByChunk[i].decisions,
      actionItems: notesByChunk[i].action_items,
    })),
  });

  const reduced = await callAndValidate(hub, input.roomId, reducePrompt, summaryPayloadSchema, SUMMARY_SCHEMA_HINT, signal);

  return verifySummary(reduced, input.chunks, input.speakerNames);
}
