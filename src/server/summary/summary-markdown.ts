/**
 * Renders `summary.md` — title, meta, then the 4 required sections (plan.md):
 * Summary, Decisions, Action items (table), Key topics. `title` and speaker
 * names are user-entered data, so they are sanitized AND markdown-escaped
 * here (RT-12); the AI-generated prose (summary/decisions/action items/key
 * topics text) is Hub AI's own output over already-fenced/sanitized input and
 * is rendered as-is, matching `transcript/markdown-writer.ts`'s convention of
 * not re-escaping segment text.
 */
import type { SummaryPayload } from './summarizer.js';
import { escapeMarkdown, SUMMARY_MARKDOWN_LABELS, type SummaryLanguage } from './prompts.js';
import { sanitizeDisplayName } from './sanitize.js';

export interface RenderSummaryMarkdownInput {
  title: string;
  startedAt: string;
  durationSec: number;
  speakers: readonly string[];
  payload: SummaryPayload;
  language: SummaryLanguage;
}

function formatTimestamp(totalSec: number): string {
  const sec = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
}

function escapeCell(text: string): string {
  return escapeMarkdown(text).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

export function renderSummaryMarkdown(input: RenderSummaryMarkdownInput): string {
  const labels = SUMMARY_MARKDOWN_LABELS[input.language];
  const safeTitle = escapeMarkdown(sanitizeDisplayName(input.title) || (input.language === 'vi' ? 'Cuộc họp' : 'Meeting'));
  const safeSpeakers = input.speakers.map((s) => escapeMarkdown(sanitizeDisplayName(s))).join(', ');

  const lines: string[] = [];
  lines.push(`# ${safeTitle}`);
  lines.push('');
  lines.push(`- ${labels.meta.startedAt}: ${input.startedAt}`);
  lines.push(`- ${labels.meta.duration}: ${formatTimestamp(input.durationSec)}`);
  lines.push(`- ${labels.meta.speakers}: ${safeSpeakers || '—'}`);
  lines.push('');

  lines.push(`## ${labels.summary}`);
  lines.push('');
  lines.push(input.payload.summary || '—');
  lines.push('');

  lines.push(`## ${labels.decisions}`);
  lines.push('');
  if (input.payload.decisions.length > 0) {
    for (const decision of input.payload.decisions) lines.push(`- ${decision}`);
  } else {
    lines.push('—');
  }
  lines.push('');

  lines.push(`## ${labels.actionItems}`);
  lines.push('');
  if (input.payload.action_items.length > 0) {
    lines.push(`| ${labels.task} | ${labels.owner} | ${labels.due} | ${labels.at} |`);
    lines.push('| --- | --- | --- | --- |');
    for (const item of input.payload.action_items) {
      const at = typeof item.at === 'number' ? formatTimestamp(item.at) : '—';
      lines.push(`| ${escapeCell(item.task)} | ${escapeCell(item.owner ?? '—')} | ${escapeCell(item.due ?? '—')} | ${at} |`);
    }
  } else {
    lines.push('—');
  }
  lines.push('');

  lines.push(`## ${labels.keyTopics}`);
  lines.push('');
  lines.push(input.payload.key_topics.length > 0 ? input.payload.key_topics.map((t) => escapeMarkdown(t)).join(', ') : '—');
  lines.push('');

  return lines.join('\n');
}
