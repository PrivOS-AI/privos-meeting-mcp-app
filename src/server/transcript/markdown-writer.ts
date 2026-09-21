/**
 * `transcript.md` — a human-readable rendering of the same segments as
 * `transcript.json`. `# <title>` + meta, then one `## [HH:MM:SS] <speaker>`
 * heading per segment followed by its text — and, when the segment carries a
 * `translation` (P6 bilingual pass), an indented italic line right under it
 * so the two languages read together without a second document.
 */
import type { Segment } from './segment-builder.js';

function formatTimestamp(totalSec: number): string {
  const sec = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
}

export interface BuildTranscriptMarkdownInput {
  title: string;
  startedAt: string;
  durationSec: number;
  languageCode: string;
  provider: string;
  segments: readonly Segment[];
  /** speakerId -> resolved display name (P4). Falls back to the raw speakerId when absent. */
  displayNameBySpeaker?: Record<string, string>;
}

export function buildTranscriptMarkdown(input: BuildTranscriptMarkdownInput): string {
  const lines: string[] = [];
  lines.push(`# ${input.title || 'Meeting'}`);
  lines.push('');
  lines.push(`- Started: ${input.startedAt}`);
  lines.push(`- Duration: ${formatTimestamp(input.durationSec)}`);
  lines.push(`- Language: ${input.languageCode}`);
  lines.push(`- Provider: ${input.provider}`);
  lines.push('');

  for (const segment of input.segments) {
    const name = input.displayNameBySpeaker?.[segment.speakerId] ?? segment.speakerId;
    lines.push(`## [${formatTimestamp(segment.startSec)}] ${name}`);
    lines.push('');
    lines.push(segment.text);
    if (segment.translation) {
      lines.push('');
      lines.push(`*${segment.translation}*`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
