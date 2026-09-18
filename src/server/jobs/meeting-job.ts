/**
 * Orchestrates one post-meeting processing job: concat parts -> decode wav16k
 * -> transcribe via the job's PINNED async provider -> segment -> embed/match
 * speakers (P4) -> (P5 reconcile, P6 summarize — stub hooks kept at the exact
 * call sites those phases wire into) -> write transcript.json/.md/.srt -> App
 * DB. `patch()` after every step keeps `meeting_status` accurate; a heartbeat
 * interval covers a single long-running step (an STT poll) so it never looks
 * dead to `sweepStale`. `finally` always clears the job's scratch directory.
 */
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

import type { RoomBoundHubClient } from '@privos_ai/app-server';

import { AppError } from '../../shared/app-error.js';
import { AppDbBotClient } from '../hub/app-db-bot-client.js';
import { uploadBotFile } from '../files/hub-file-upload.js';
import { concatParts, deletePartFiles, type PartRef } from '../media/concat-parts.js';
import { decodeToWav16k } from '../media/decode-audio.js';
import { deleteRoomFile } from '../media/hub-file-download.js';
import { readLiveTurns } from '../media/live-turns-store.js';
import { dataDir } from '../paths.js';
import { resolveSpeakers as resolveSpeakersEmbed } from '../speaker/resolve-speakers.js';
import { asyncProviderFor } from '../stt/stt-provider-registry.js';
import { alignByMaxOverlap } from '../transcript/caption-aligner.js';
import { buildSegments, type Segment } from '../transcript/segment-builder.js';
import { buildTranscriptMarkdown } from '../transcript/markdown-writer.js';
import { buildTranscriptJson, serializeTranscriptJson } from '../transcript/transcript-json.js';
import { buildSrt } from '../transcript/srt-writer.js';
import { HEARTBEAT_INTERVAL_MS, JobRepository, type JobRecord, type JobResultSpeaker } from './job-repository.js';
import { deleteUnmappedLiveSpeakers, mergeLiveIntoAsyncSpeaker, upsertMeeting, upsertMeetingSpeakers, type SpeakerUpsertInput } from './meeting-repository.js';

export interface RunMeetingJobInput {
  job: JobRecord;
  roomId: string;
  folderId: string;
  parts: readonly PartRef[];
  agentBotHub: RoomBoundHubClient;
  signal: AbortSignal;
}

// ---- P6 seam — real logic lands in P6; kept here so the orchestrator's
// call site never moves once that phase lands. ----

const RECONCILE_TOLERANCE_MS = 1500;

/**
 * Reconciles the async pass's segmentation (authoritative — plan.md) against
 * `live-turns.json` (P5's live registry) so each real person ends up with
 * exactly ONE `meeting_speakers` row, `sessionSpeakerId` filled in, and no
 * lingering standalone live-only rows.
 *
 * For each async `speakerId`, picks whichever live `sessionSpeakerId`
 * overlaps its segments the MOST (summed overlap, via
 * `caption-aligner.alignByMaxOverlap`) and folds that live row's metadata
 * into the async row (`mergeLiveIntoAsyncSpeaker` — name priority `user` >
 * `async` > `live`). Live session speakers that never overlapped any async
 * speaker are deleted as noise. A no-op when the meeting never produced a
 * `live-turns.json` (ElevenLabs-degraded meetings, or a meeting with no
 * speech long enough to go live).
 *
 * Returns `speakerId -> sessionSpeakerId` for the mapped speakers, so the
 * caller can also carry `liveSessionSpeakerId` onto the `JobResult` it
 * returns from the tool (never re-querying App DB just for that).
 */
async function reconcileWithLiveSpeakers(
  db: AppDbBotClient,
  hub: RoomBoundHubClient,
  roomId: string,
  folderId: string,
  meetingId: string,
  segments: readonly Segment[],
  speakers: readonly JobResultSpeaker[],
): Promise<Map<string, string>> {
  const mapped = new Map<string, string>();
  const live = await readLiveTurns(hub, roomId, folderId);
  if (!live || live.turns.length === 0) return mapped;

  const asyncSpans = segments.map((s) => ({ startMs: Math.round(s.startSec * 1000), endMs: Math.round(s.endSec * 1000), speakerId: s.speakerId }));
  const aligned = alignByMaxOverlap(asyncSpans, live.turns, { toleranceMs: RECONCILE_TOLERANCE_MS });

  const overlapMsBySpeaker = new Map<string, Map<string, number>>();
  for (const { a, b } of aligned) {
    if (!b) continue;
    const overlapMs = Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs);
    if (overlapMs <= 0) continue;
    const bySession = overlapMsBySpeaker.get(a.speakerId) ?? new Map<string, number>();
    bySession.set(b.speakerKey, (bySession.get(b.speakerKey) ?? 0) + overlapMs);
    overlapMsBySpeaker.set(a.speakerId, bySession);
  }

  for (const speaker of speakers) {
    const bySession = overlapMsBySpeaker.get(speaker.speakerId);
    if (!bySession || bySession.size === 0) continue;
    const [sessionSpeakerId] = [...bySession.entries()].sort((x, y) => y[1] - x[1])[0];
    await mergeLiveIntoAsyncSpeaker(db, meetingId, speaker.speakerId, sessionSpeakerId);
    mapped.set(speaker.speakerId, sessionSpeakerId);
  }

  await deleteUnmappedLiveSpeakers(db, meetingId, new Set(mapped.values()));
  return mapped;
}

/** P6 seam: Hub AI summary + translation. Returns `undefined` until P6 ships. */
async function summarizeTranscript(_segments: readonly Segment[], _language: string): Promise<undefined> {
  return undefined;
}

// ---- orchestration ----

function scratchDir(jobId: string): string {
  return path.join(dataDir, 'tmp', jobId);
}

export async function runMeetingJob(input: RunMeetingJobInput): Promise<void> {
  const { job, roomId, folderId, parts, agentBotHub, signal } = input;
  const db = new AppDbBotClient(roomId);
  const jobRepo = new JobRepository(db);
  const scratch = scratchDir(job.jobId);

  const heartbeat = setInterval(() => void jobRepo.heartbeat(job._id), HEARTBEAT_INTERVAL_MS);
  try {
    await jobRepo.markProcessing(job._id);
    await mkdir(scratch, { recursive: true });
    await db.update('meetings', 'room', job.meetingId, { status: 'processing' }).catch(() => undefined);

    // 1. download + concat parts -> audio.webm (local scratch copy) -> upload -> delete parts.
    await jobRepo.patch(job._id, { step: 'download', progress: 0.05 });
    const webmPath = path.join(scratch, 'audio.webm');
    await concatParts(agentBotHub, job.meetingId, parts, job.partFileIds, webmPath, signal);

    const audioUpload = await uploadBotFile({
      hub: agentBotHub,
      roomId,
      folderId,
      fileName: 'audio.webm',
      mimeType: 'audio/webm',
      data: { filePath: webmPath },
      duplicateAction: 'replace',
      signal,
    });
    await jobRepo.patch(job._id, { audioFileId: audioUpload.fileId });
    await deletePartFiles(agentBotHub, job.partFileIds, signal);

    // 2. decode wav16k — needed for elevenlabs-batch's input AND (P4) embedding.
    await jobRepo.patch(job._id, { step: 'decode', progress: 0.2 });
    const wavPath = path.join(scratch, 'audio-16k.wav');
    const decoded = await decodeToWav16k(webmPath, wavPath, signal);

    // 3. transcribe via the job's pinned provider ('elevenlabs-batch' wants the wav, 'soniox-async' the raw webm).
    await jobRepo.patch(job._id, { step: 'transcribe', progress: 0.35 });
    const providerVendor = job.sttProvider === 'elevenlabs-batch' ? 'elevenlabs' : 'soniox';
    const provider = asyncProviderFor(providerVendor);
    const audioPath = job.sttProvider === 'elevenlabs-batch' ? wavPath : webmPath;
    const sttResult = await provider.transcribeFile({
      audioPath,
      languageHints: job.language ? [job.language] : undefined,
      enableSpeakerDiarization: true,
      signal,
      clientReferenceId: job.meetingId,
      resumeProviderFileId: job.providerFileId,
      resumeProviderTranscriptionId: job.providerTranscriptionId,
      onProviderIds: (ids) => jobRepo.patch(job._id, ids),
    });

    // 4. segments — ONE builder for both providers, they already share `SttToken`.
    await jobRepo.patch(job._id, { step: 'segment', progress: 0.6 });
    const segments = buildSegments(sttResult.tokens, { pauseSplitSec: 1.5 });

    // 5. P4 embed + match/enrol against `speaker_profiles`; P5 reconciles against live-turns.json right after.
    await jobRepo.patch(job._id, { step: 'embed', progress: 0.7 });
    const resolved = await resolveSpeakersEmbed(db, wavPath, segments, job.meetingId);
    const speakerUpserts: SpeakerUpsertInput[] = resolved.map((s, i) => ({
      speakerId: s.speakerId,
      totalSpeakSec: s.totalSpeakSec,
      nameSource: s.resolved ? ('async' as const) : undefined,
      sampleStartSec: s.sampleRange?.startSec,
      sampleEndSec: s.sampleRange?.endSec,
      profileId: s.profileId,
      // plan.md § Requirements: unmatched speakers keep the numbered placeholder until `speaker_resolve` confirms a real name.
      displayName: s.resolved ? s.displayName : `Người nói ${i + 1}`,
      confidence: s.confidence,
      resolved: s.resolved,
      // A previous pass' pendingEmbedding is replaced by this pass' result — '' clears it when this pass resolved the speaker.
      pendingEmbedding: s.pendingEmbeddingJson ?? (s.resolved ? '' : undefined),
    }));
    await upsertMeetingSpeakers(db, job.meetingId, speakerUpserts);
    // JobResult never carries the sealed pendingEmbedding ciphertext — App DB (`meeting_speakers.pendingEmbedding`, just written above) is its only home.
    const speakers: JobResultSpeaker[] = resolved.map((s) => ({
      speakerId: s.speakerId,
      totalSpeakSec: s.totalSpeakSec,
      sampleSec: s.sampleSec,
      displayName: s.displayName,
      profileId: s.profileId,
      confidence: s.confidence,
      resolved: s.resolved,
      sampleRange: s.sampleRange,
    }));
    const liveSessionSpeakerIds = await reconcileWithLiveSpeakers(db, agentBotHub, roomId, folderId, job.meetingId, segments, speakers);
    for (const speaker of speakers) {
      const sessionSpeakerId = liveSessionSpeakerIds.get(speaker.speakerId);
      if (sessionSpeakerId) speaker.liveSessionSpeakerId = sessionSpeakerId;
    }

    // 6. P6 summarize (stub).
    await jobRepo.patch(job._id, { step: 'summarize', progress: 0.8 });
    const summary = await summarizeTranscript(segments, job.language);

    // 7. write transcript.json/.md/.srt to Files.
    await jobRepo.patch(job._id, { step: 'write', progress: 0.9 });
    const languageCode = sttResult.language ?? job.language;
    const durationSec = Math.round(decoded.durationSec);
    const transcriptDoc = buildTranscriptJson({
      meetingId: job.meetingId,
      title: job.title,
      startedAt: job.startedAt,
      durationSec,
      languageCode,
      provider: job.sttProvider,
      speakers: speakers.map((s) => ({ speakerId: s.speakerId, totalSpeakSec: s.totalSpeakSec, displayName: s.displayName ?? null })),
      segments,
      tokens: sttResult.tokens,
    });
    const markdown = buildTranscriptMarkdown({
      title: job.title,
      startedAt: job.startedAt,
      durationSec,
      languageCode,
      provider: job.sttProvider,
      segments,
    });
    const srt = buildSrt(segments, sttResult.tokens);

    const [jsonUpload, mdUpload, srtUpload] = await Promise.all([
      uploadBotFile({
        hub: agentBotHub, roomId, folderId, fileName: 'transcript.json', mimeType: 'application/json',
        data: serializeTranscriptJson(transcriptDoc), duplicateAction: 'replace', signal,
      }),
      uploadBotFile({
        hub: agentBotHub, roomId, folderId, fileName: 'transcript.md', mimeType: 'text/markdown',
        data: Buffer.from(markdown, 'utf8'), duplicateAction: 'replace', signal,
      }),
      uploadBotFile({
        hub: agentBotHub, roomId, folderId, fileName: 'transcript.srt', mimeType: 'application/x-subrip',
        data: Buffer.from(srt, 'utf8'), duplicateAction: 'replace', signal,
      }),
    ]);

    await upsertMeeting(db, job.meetingId, {
      status: 'summarized',
      audioFileId: audioUpload.fileId,
      transcriptJsonFileId: jsonUpload.fileId,
      transcriptMdFileId: mdUpload.fileId,
      srtFileId: srtUpload.fileId,
      speakerCount: speakers.length,
      durationSec,
    });

    // 8. cleanup — delete audio.webm ONLY when keepAudio===false AND summarize succeeded.
    // (P3's summarize stub always "succeeds" with no summary, so this already exercises the real gate P6 will rely on.)
    await jobRepo.patch(job._id, { step: 'cleanup', progress: 0.98 });
    if (!job.keepAudio) {
      await deleteRoomFile(agentBotHub, audioUpload.fileId, signal)
        .then(() => upsertMeeting(db, job.meetingId, { audioDeletedAt: new Date().toISOString() }))
        .catch((error) => {
          console.warn('[meeting-job] xoá audio.webm thất bại (không chặn job hoàn tất):', error instanceof Error ? error.message : error);
        });
    }

    await jobRepo.finish(job._id, {
      durationSec,
      languageCode,
      sttProvider: job.sttProvider,
      speakers,
      fileIds: { transcriptJson: jsonUpload.fileId, transcriptMd: mdUpload.fileId, srt: srtUpload.fileId },
      summary,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[meeting-job] failed', { jobId: job.jobId, meetingId: job.meetingId, error: message, stack: error instanceof Error ? error.stack : undefined });
    await jobRepo.fail(job._id, message);
    await db.update('meetings', 'room', job.meetingId, { status: 'failed', summaryError: message.slice(0, 4000) }).catch(() => undefined);
    throw error instanceof Error ? error : new AppError(message);
  } finally {
    clearInterval(heartbeat);
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}
