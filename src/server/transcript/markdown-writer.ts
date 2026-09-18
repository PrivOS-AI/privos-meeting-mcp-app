/**
 * `transcript.md` — a human-readable rendering of the same segments as
 * `transcript.json`. `# <title>` + meta, then one `## [HH:MM:SS] <speaker>`
 * heading per segment followed by its text.
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
  lines.push(`# ${input.title || 'Cuộc họp'}`);
  lines.push('');
  lines.push(`- Bắt đầu: ${input.startedAt}`);
  lines.push(`- Thời lượng: ${formatTimestamp(input.durationSec)}`);
  lines.push(`- Ngôn ngữ: ${input.languageCode}`);
  lines.push(`- Nhà cung cấp: ${input.provider}`);
  lines.push('');

  for (const segment of input.segments) {
    const name = input.displayNameBySpeaker?.[segment.speakerId] ?? segment.speakerId;
    lines.push(`## [${formatTimestamp(segment.startSec)}] ${name}`);
    lines.push('');
    lines.push(segment.text);
    lines.push('');
  }

  return lines.join('\n');
}
