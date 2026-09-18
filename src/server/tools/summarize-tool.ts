/**
 * `meeting_summarize {roomId, meetingId}` — re-runs ONLY the summarize (+
 * bundled translate) step from the already-written `transcript.json`,
 * without re-transcribing/re-embedding. Backs the UI's "Tạo lại tóm tắt"
 * button — most useful right after Hub AI failed during the original job
 * (`meetings.summaryError` set, transcript intact) or after speakers were
 * renamed via `speaker_resolve` and the user wants the summary to use the
 * corrected names.
 *
 * Reuses the exact same `summarizeTranscript` hook `meeting-job.ts` calls
 * (DRY) — same map-reduce, same prompt-injection guards, same non-fatal
 * error handling shape, just triggered on demand instead of from the job
 * pipeline. Also rewrites transcript.json/.md/.srt so a translate-bundled
 * re-run's `.translation` fields are not silently lost.
 */
import { text as streamToText } from 'node:stream/consumers';

import { AppError } from '../../shared/app-error.js';
import { AppDbBotClient, extractDbRecords } from '../hub/app-db-bot-client.js';
import { uploadBotFile } from '../files/hub-file-upload.js';
import { fetchFileReadable } from '../media/hub-file-download.js';
import { summarizeTranscript } from '../jobs/meeting-job.js';
import { upsertMeeting } from '../jobs/meeting-repository.js';
import { buildTranscriptMarkdown } from '../transcript/markdown-writer.js';
import { buildTranscriptJson, serializeTranscriptJson, type TranscriptJson } from '../transcript/transcript-json.js';
import { buildSrt } from '../transcript/srt-writer.js';
import { requireMeetingOwner, requireVerifiedActor } from './authz.js';
import type { AppTool, ToolRuntime } from './registry.js';

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isTranscriptJson(value: unknown): value is TranscriptJson {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return Array.isArray(record.segments) && Array.isArray(record.tokens) && Array.isArray(record.speakers);
}

export const summarizeTool: AppTool = {
  name: 'meeting_summarize',
  title: 'Tóm tắt lại cuộc họp',
  description: 'Chạy lại riêng bước tóm tắt bằng Hub AI từ transcript đã lưu, không xử lý lại toàn bộ.',
  inputSchema: {
    type: 'object',
    required: ['roomId', 'meetingId'],
    properties: { roomId: { type: 'string' }, meetingId: { type: 'string' } },
  },
  async execute(args, context, runtime: ToolRuntime) {
    const actor = requireVerifiedActor(context);
    const roomId = asString(args.roomId);
    const meetingId = asString(args.meetingId);
    if (!roomId || !meetingId) throw new AppError('roomId và meetingId là bắt buộc.');

    const db = new AppDbBotClient(roomId);
    const meeting = await requireMeetingOwner(db, actor, roomId, meetingId);
    if (!meeting.transcriptJsonFileId || typeof meeting.transcriptJsonFileId !== 'string') {
      throw new AppError('Cuộc họp chưa có transcript để tóm tắt.');
    }
    const folderId = typeof meeting.folderId === 'string' ? meeting.folderId : '';
    if (!folderId) throw new AppError('Cuộc họp chưa có thư mục lưu trữ.');

    const readable = await fetchFileReadable(runtime.agentBotHub, meeting.transcriptJsonFileId);
    const raw = await streamToText(readable);
    let transcriptDoc: unknown;
    try {
      transcriptDoc = JSON.parse(raw);
    } catch {
      throw new AppError('Không đọc được transcript.json — tệp không hợp lệ.');
    }
    if (!isTranscriptJson(transcriptDoc)) {
      throw new AppError('transcript.json không đúng định dạng mong đợi.');
    }

    // Prefer the CURRENT `meeting_speakers` display names (may have been corrected by `speaker_resolve` since the
    // job ran) over the names frozen inside transcript.json at write time.
    const speakerRows = extractDbRecords(
      await db.query('meeting_speakers', 'room', { where: [{ field: 'meeting', op: '==', value: meetingId }], limit: 1000 }),
    );
    const displayNameBySpeaker: Record<string, string> = {};
    for (const row of speakerRows) {
      if (typeof row.speakerId === 'string' && typeof row.displayName === 'string' && row.displayName) {
        displayNameBySpeaker[row.speakerId] = row.displayName;
      }
    }
    for (const s of transcriptDoc.speakers) {
      if (!displayNameBySpeaker[s.speakerId] && s.displayName) displayNameBySpeaker[s.speakerId] = s.displayName;
    }

    const speakers = transcriptDoc.speakers.map((s) => ({
      speakerId: s.speakerId,
      totalSpeakSec: s.totalSpeakSec,
      displayName: displayNameBySpeaker[s.speakerId] ?? s.displayName ?? s.speakerId,
    }));

    let summarized: Awaited<ReturnType<typeof summarizeTranscript>> | undefined;
    let summaryError: string | undefined;
    try {
      summarized = await summarizeTranscript({
        db,
        hub: runtime.agentBotHub,
        roomId,
        folderId,
        meetingId,
        title: typeof meeting.title === 'string' ? meeting.title : '',
        startedAt: typeof meeting.startedAt === 'string' ? meeting.startedAt : transcriptDoc.startedAt,
        durationSec: typeof meeting.durationSec === 'number' ? meeting.durationSec : transcriptDoc.durationSec,
        language: typeof meeting.language === 'string' ? meeting.language : transcriptDoc.languageCode,
        translationEnabled: meeting.translationEnabled === true,
        translationLang: typeof meeting.translationLang === 'string' ? meeting.translationLang : undefined,
        segments: transcriptDoc.segments,
        speakers,
      });
    } catch (error) {
      summaryError = error instanceof Error ? error.message : String(error);
    }

    if (!summarized) {
      await upsertMeeting(db, meetingId, { summaryError: (summaryError ?? 'Tóm tắt thất bại.').slice(0, 4000) });
      throw new AppError(summaryError ?? 'Tóm tắt bằng Hub AI thất bại.');
    }

    const finalSegments = summarized.translatedSegments;
    const durationSec = typeof meeting.durationSec === 'number' ? meeting.durationSec : transcriptDoc.durationSec;
    const languageCode = transcriptDoc.languageCode;
    const rewrittenDoc = buildTranscriptJson({
      meetingId,
      title: typeof meeting.title === 'string' ? meeting.title : transcriptDoc.title,
      startedAt: transcriptDoc.startedAt,
      durationSec,
      languageCode,
      translationLang: typeof meeting.translationLang === 'string' ? meeting.translationLang : undefined,
      provider: transcriptDoc.provider,
      speakers: transcriptDoc.speakers,
      segments: finalSegments,
      tokens: transcriptDoc.tokens,
    });
    const markdown = buildTranscriptMarkdown({
      title: typeof meeting.title === 'string' ? meeting.title : transcriptDoc.title,
      startedAt: transcriptDoc.startedAt,
      durationSec,
      languageCode,
      provider: transcriptDoc.provider,
      segments: finalSegments,
      displayNameBySpeaker,
    });
    const srt = buildSrt(finalSegments, transcriptDoc.tokens);

    const [jsonUpload, mdUpload, srtUpload] = await Promise.all([
      uploadBotFile({
        hub: runtime.agentBotHub, roomId, folderId, fileName: 'transcript.json', mimeType: 'application/json',
        data: serializeTranscriptJson(rewrittenDoc), duplicateAction: 'replace',
      }),
      uploadBotFile({
        hub: runtime.agentBotHub, roomId, folderId, fileName: 'transcript.md', mimeType: 'text/markdown',
        data: Buffer.from(markdown, 'utf8'), duplicateAction: 'replace',
      }),
      uploadBotFile({
        hub: runtime.agentBotHub, roomId, folderId, fileName: 'transcript.srt', mimeType: 'application/x-subrip',
        data: Buffer.from(srt, 'utf8'), duplicateAction: 'replace',
      }),
    ]);

    await upsertMeeting(db, meetingId, {
      transcriptJsonFileId: jsonUpload.fileId,
      transcriptMdFileId: mdUpload.fileId,
      srtFileId: srtUpload.fileId,
      summaryFileId: summarized.summaryFileId,
      summaryText: summarized.payload.summary.slice(0, 20_000),
      keyTopics: summarized.payload.key_topics,
      summaryError: '',
    });

    return {
      summary: summarized.payload,
      summaryFileId: summarized.summaryFileId,
      transcriptJsonFileId: jsonUpload.fileId,
      transcriptMdFileId: mdUpload.fileId,
      srtFileId: srtUpload.fileId,
    };
  },
};
