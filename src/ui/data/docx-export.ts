/**
 * Client-side DOCX export (D-11: generated in the iframe with the `docx`
 * npm package + `Packer.toBlob`/`Packer.toBuffer` — no backend DOCX tool).
 * Mirrors `summary-markdown.ts`'s section order so the exported Word file
 * and the stored `summary.md` never diverge in structure: title → meta →
 * Summary → Decisions → Action items → Minutes (one paragraph per
 * transcript segment, bilingual when a `translation` is present).
 */
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx';

import { formatClock } from './format-time.js';

export interface DocxSpeaker {
  speakerId: string;
  displayName: string;
}

export interface DocxSegment {
  speakerId: string;
  startSec: number;
  text: string;
  translation?: string;
}

export interface DocxActionItem {
  task: string;
  owner: string | null;
  due: string | null;
}

export interface DocxSummary {
  summary: string;
  decisions: string[];
  action_items: DocxActionItem[];
  key_topics: string[];
}

export interface BuildMeetingDocxInput {
  title: string;
  startedAt: string;
  durationSec: number;
  speakers: DocxSpeaker[];
  segments: DocxSegment[];
  summary?: DocxSummary;
  language: import('../../shared/languages.js').LanguageCode;
}

const LABELS = {
  vi: { summary: 'Tóm tắt', decisions: 'Quyết định', actions: 'Việc cần làm', minutes: 'Biên bản', none: 'Không có.', speakers: 'người nói' },
  en: { summary: 'Summary', decisions: 'Decisions', actions: 'Action items', minutes: 'Minutes', none: 'None.', speakers: 'speakers' },
} as const;

function displayNameFor(speakerId: string, speakers: readonly DocxSpeaker[]): string {
  return speakers.find((s) => s.speakerId === speakerId)?.displayName ?? speakerId;
}

/** Builds the in-memory `docx` `Document` — pure and Node-testable via `Packer.toBuffer` (no browser APIs). */
export function buildMeetingDocx(input: BuildMeetingDocxInput): Document {
  // DOCX section labels only ship vi/en; any other meeting language falls back to English.
  // DOCX section labels only ship vi/en; any other meeting language uses English.
  const labels = input.language === 'vi' ? LABELS.vi : LABELS.en;
  const children: Paragraph[] = [
    new Paragraph({ text: input.title, heading: HeadingLevel.HEADING_1 }),
    new Paragraph({
      children: [new TextRun(`${new Date(input.startedAt).toLocaleString()} · ${formatClock(input.durationSec)} · ${input.speakers.length} ${labels.speakers}`)],
    }),
  ];

  if (input.summary) {
    children.push(new Paragraph({ text: labels.summary, heading: HeadingLevel.HEADING_2 }));
    children.push(new Paragraph({ text: input.summary.summary || labels.none }));

    children.push(new Paragraph({ text: labels.decisions, heading: HeadingLevel.HEADING_2 }));
    if (input.summary.decisions.length === 0) children.push(new Paragraph({ text: labels.none }));
    else for (const decision of input.summary.decisions) children.push(new Paragraph({ text: `• ${decision}` }));

    children.push(new Paragraph({ text: labels.actions, heading: HeadingLevel.HEADING_2 }));
    if (input.summary.action_items.length === 0) children.push(new Paragraph({ text: labels.none }));
    else {
      for (const item of input.summary.action_items) {
        const meta = [item.owner, item.due].filter(Boolean).join(' · ');
        children.push(new Paragraph({ text: meta ? `• ${item.task} (${meta})` : `• ${item.task}` }));
      }
    }
  }

  children.push(new Paragraph({ text: labels.minutes, heading: HeadingLevel.HEADING_2 }));
  if (input.segments.length === 0) children.push(new Paragraph({ text: labels.none }));
  for (const segment of input.segments) {
    const speaker = displayNameFor(segment.speakerId, input.speakers);
    const text = segment.translation ? `${segment.text}\n${segment.translation}` : segment.text;
    children.push(
      new Paragraph({
        children: [new TextRun({ text: `[${formatClock(segment.startSec)}] ${speaker}: `, bold: true }), new TextRun(text)],
      }),
    );
  }

  return new Document({ sections: [{ children }] });
}

/** Browser-only `Packer.toBlob` step, kept separate so `buildMeetingDocx` stays pure/Node-testable. */
export async function meetingDocxToBlob(doc: Document): Promise<Blob> {
  return Packer.toBlob(doc);
}
