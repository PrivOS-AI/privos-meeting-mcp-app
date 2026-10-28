/**
 * Clients for asking about a meeting (`meeting_ask`), saving an answer to
 * Files (`meeting_save_answer`) and saving the owner's notes
 * (`meeting_notes_save`). Errors surface as `ToolCallError` with the server's code.
 */
import type { McpApp } from '@privos_ai/app-react';

import type { LiveSummaryLine } from './live-summary-api.js';
import { parseToolResultOrThrow } from './tool-error.js';

export interface QaCitation {
  lineId: string;
  atSec: number;
  speaker: string;
  quote: string;
}

export interface QaAnswer {
  answer: string;
  citations: QaCitation[];
  insufficient: boolean;
}

export interface AskResult extends QaAnswer {
  /** Short-lived proof that the server gave this exact answer — required to save it. */
  saveToken: string;
}

export async function askMeeting(
  app: McpApp,
  input: { roomId: string; meetingId: string; question: string; language: string; segments?: LiveSummaryLine[] },
): Promise<AskResult> {
  const raw = await app.callServerTool({
    name: 'meeting_ask',
    // No caption lines (a finished meeting): the server answers from the saved transcript.
    arguments: input.segments?.length ? input : { ...input, segments: undefined },
    timeoutMs: 120_000,
  });
  return parseToolResultOrThrow(raw) as unknown as AskResult;
}

export async function saveAnswer(
  app: McpApp,
  input: { roomId: string; meetingId: string; question: string; answer: QaAnswer; saveToken: string },
): Promise<{ saved: boolean; alreadySaved: boolean; fileName: string }> {
  const raw = await app.callServerTool({ name: 'meeting_save_answer', arguments: input, timeoutMs: 60_000 });
  return parseToolResultOrThrow(raw) as unknown as { saved: boolean; alreadySaved: boolean; fileName: string };
}

export async function saveNotes(
  app: McpApp,
  input: { roomId: string; meetingId: string; text: string; revision: number },
): Promise<{ saved: boolean; stale: boolean }> {
  const raw = await app.callServerTool({ name: 'meeting_notes_save', arguments: input });
  return parseToolResultOrThrow(raw) as unknown as { saved: boolean; stale: boolean };
}
