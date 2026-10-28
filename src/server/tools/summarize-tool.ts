/**
 * `meeting_summarize {roomId, meetingId}` — re-runs ONLY the summarize (+
 * bundled translate) step from the already-written `transcript.json`,
 * without re-transcribing/re-embedding. Backs the UI's "Regenerate summary"
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

import { AppError } from '../../shared/app-error.js';
import { AppDbBotClient } from '../hub/app-db-bot-client.js';
import { uploadBotFile } from '../files/hub-file-upload.js';
import { summarizeTranscript } from '../jobs/meeting-job.js';
import { upsertMeeting } from '../jobs/meeting-repository.js';
import { buildTranscriptMarkdown } from '../transcript/markdown-writer.js';
import { loadStoredTranscript } from '../transcript/stored-transcript.js';
import { buildTranscriptJson, serializeTranscriptJson } from '../transcript/transcript-json.js';
import { buildSrt } from '../transcript/srt-writer.js';
import { requireMeetingOwner, requireVerifiedActor } from './authz.js';
import type { AppTool, ToolRuntime } from './registry.js';
import { ROOM_AND_MEETING } from './schema-parts.js';

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export const summarizeTool: AppTool = {
  name: 'meeting_summarize',
  title: 'Re-summarize meeting',
  description: 'Re-run only the summary step with Hub AI from the saved transcript, without reprocessing everything.',
  inputSchema: { type: 'object', required: ['roomId', 'meetingId'], properties: { ...ROOM_AND_MEETING } },
  async execute(args, context, runtime: ToolRuntime) {
    const actor = requireVerifiedActor(context);
    const roomId = asString(args.roomId);
    const meetingId = asString(args.meetingId);
    if (!roomId || !meetingId) throw new AppError('roomId and meetingId are required.', 'INVALID_INPUT');

    const db = new AppDbBotClient(roomId);
    const meeting = await requireMeetingOwner(db, actor, roomId, meetingId);
    if (!meeting.transcriptJsonFileId || typeof meeting.transcriptJsonFileId !== 'string') {
      throw new AppError('Meeting has no transcript to summarize.', 'INVALID_STATE');
    }
    const folderId = typeof meeting.folderId === 'string' ? meeting.folderId : '';
    if (!folderId) throw new AppError('Meeting has no storage folder yet.', 'INVALID_STATE');

    const { doc: transcriptDoc, displayNameBySpeaker } = await loadStoredTranscript(db, runtime.agentBotHub, meeting);

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
      await upsertMeeting(db, meetingId, { summaryError: (summaryError ?? 'Summary failed.').slice(0, 4000) });
      throw new AppError(summaryError ?? 'Summarizing with Hub AI failed.', 'HUB_ERROR');
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
    const srt = buildSrt(finalSegments, transcriptDoc.tokens, transcriptDoc.provider === 'soniox-async');

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
