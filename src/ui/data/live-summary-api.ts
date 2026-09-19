/**
 * Thin `callServerTool` wrapper for `meeting_live_summary` — the in-progress
 * summary shown in the live "Summary" panel (refreshed every ~10 minutes).
 * Same `parseToolResult` unwrap pattern as the other UI tool clients.
 */
import { parseToolResult } from '@privos_ai/app-react';
import type { McpApp } from '@privos_ai/app-react';

export interface LiveSummaryLine {
  speakerId: string;
  speakerName: string;
  startSec: number;
  text: string;
}

export interface LiveSummaryActionItem {
  task: string;
  owner: string | null;
  due: string | null;
  at: number | null;
}

export interface LiveSummaryResult {
  summary: string;
  decisions: string[];
  action_items: LiveSummaryActionItem[];
  key_topics: string[];
}

export async function fetchLiveSummary(
  app: McpApp,
  input: { roomId: string; meetingId: string; title: string; language: 'vi' | 'en'; segments: LiveSummaryLine[] },
): Promise<LiveSummaryResult> {
  const raw = await app.callServerTool({
    name: 'meeting_live_summary',
    arguments: {
      roomId: input.roomId,
      meetingId: input.meetingId,
      title: input.title,
      language: input.language,
      segments: input.segments,
    },
  });
  return parseToolResult(raw) as unknown as LiveSummaryResult;
}
