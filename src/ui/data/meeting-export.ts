/**
 * Shared "Export SRT"/"Export DOCX" actions, used by both the history row
 * menu and the meeting detail screen (phase-07 § Requirements/Implementation
 * Steps 11-12) — kept in one place so the two entry points never diverge.
 *
 * SRT: downloads the artifact already written by the backend job
 * (`meetings.srtFileId`), never regenerated client-side. DOCX: generated in
 * the iframe (QĐ-11) from `transcript.json` + the meeting's own stored
 * fields; `decisions[]` is always empty here — `meeting-job.ts` only
 * persists `payload.summary`/`payload.key_topics` onto `meetings`, decisions
 * live solely in the saved `summary.md` (not re-derivable from App DB).
 */
import type { McpApp } from '@privos_ai/app-react';

import { listActionItems } from './action-item-read-model.js';
import { asLanguageCode } from '../../shared/languages.js';
import { buildMeetingDocx, meetingDocxToBlob, type DocxSummary } from './docx-export.js';
import { resolveFileUrl } from './file-download.js';
import type { MeetingReadModel } from './meeting-read-model.js';
import { loadTranscript } from './transcript-loader.js';

function triggerDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export async function downloadMeetingSrt(app: McpApp, meeting: MeetingReadModel): Promise<void> {
  if (!meeting.srtFileId) throw new Error('Cuộc họp chưa có tệp phụ đề SRT.');
  const { url } = await resolveFileUrl(app, meeting.srtFileId, 'application/x-subrip');
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Không tải được transcript.srt (HTTP ${response.status}).`);
  triggerDownload(await response.blob(), `${meeting.title || 'meeting'}.srt`);
}

export async function downloadMeetingDocx(app: McpApp, meeting: MeetingReadModel): Promise<void> {
  if (!meeting.transcriptJsonFileId) throw new Error('Cuộc họp chưa có transcript để xuất DOCX.');
  const [transcript, actionItems] = await Promise.all([loadTranscript(app, meeting.transcriptJsonFileId), listActionItems(app, meeting._id)]);

  const summary: DocxSummary | undefined = meeting.summaryText
    ? {
        summary: meeting.summaryText,
        decisions: [],
        action_items: actionItems.map((item) => ({ task: item.task, owner: item.owner, due: item.due })),
        key_topics: meeting.keyTopics ?? [],
      }
    : undefined;

  const doc = buildMeetingDocx({
    title: meeting.title || 'Meeting',
    startedAt: meeting.startedAt ?? transcript.startedAt,
    durationSec: meeting.durationSec ?? transcript.durationSec,
    speakers: transcript.speakers.map((s) => ({ speakerId: s.speakerId, displayName: s.displayName ?? s.speakerId })),
    segments: transcript.segments.map((s) => ({ speakerId: s.speakerId, startSec: s.startSec, text: s.text, translation: s.translation })),
    summary,
    language: asLanguageCode(meeting.language),
  });
  triggerDownload(await meetingDocxToBlob(doc), `${meeting.title || 'meeting'}.docx`);
}
