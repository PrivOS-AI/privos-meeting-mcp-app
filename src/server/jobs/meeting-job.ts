/**
 * Orchestrates one post-meeting processing job: concat parts -> decode wav16k
 * -> transcribe via the job's PINNED async provider -> segment -> embed/match
 * speakers (P4) -> P5 reconcile -> P6 translate (optional) + summarize via
 * Hub AI -> write transcript.json/.md/.srt (+ summary.md) -> App DB.
 * `patch()` after every step keeps `meeting_status` accurate; a heartbeat
 * interval covers a single long-running step (an STT poll, or the Hub AI
 * summarize pass) so it never looks dead to `sweepStale`. `finally` always
 * clears the job's scratch directory.
 */
import { asLanguageCode, isLanguageCode } from '../../shared/languages.js';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

import type { RoomBoundHubClient } from '@privos_ai/app-server';

import { AppError } from '../../shared/app-error.js';
import { AppDbBotClient } from '../hub/app-db-bot-client.js';
import { uploadBotFile } from '../files/hub-file-upload.js';
import { concatParts, deletePartFiles, type PartRef } from '../media/concat-parts.js';
import { decodeToWav16k } from '../media/decode-audio.js';
import { deleteRoomFile } from '../media/hub-file-download.js';
import { readLiveTurns, type LiveTurnSpan } from '../media/live-turns-store.js';
import { dataDir } from '../paths.js';
import { abortMeetingQueue } from '../live-speakers/chunk-worker.js';
import { resolveSpeakers as resolveSpeakersEmbed, type UserIdentity } from '../speaker/resolve-speakers.js';
import { sessionRegistries } from '../speaker/session-speaker-registry.js';
import { uploadRoomCopy } from '../speaker/speaker-diagnostics-log.js';
import { chunkTranscript } from '../summary/chunker.js';
import { renderSummaryMarkdown } from '../summary/summary-markdown.js';
import { summarizeTranscript as runSummarizer, type SummaryPayload } from '../summary/summarizer.js';
import { translateSegmentsBatch } from '../summary/translator.js';
import { asyncProviderFor } from '../stt/stt-provider-registry.js';
import { alignByMaxOverlap } from '../transcript/caption-aligner.js';
import { buildSegments, type Segment } from '../transcript/segment-builder.js';
import { buildTranscriptMarkdown } from '../transcript/markdown-writer.js';
import { buildTranscriptJson, serializeTranscriptJson } from '../transcript/transcript-json.js';
import { buildSrt } from '../transcript/srt-writer.js';
import { HEARTBEAT_INTERVAL_MS, JobRepository, type JobRecord, type JobResultSpeaker } from './job-repository.js';
import {
  deleteUnmappedLiveSpeakers,
  loadLiveIdentities,
  mergeLiveIntoAsyncSpeaker,
  replaceActionItems,
  upsertMeeting,
  upsertMeetingSpeakers,
  type LiveIdentity,
  type SpeakerUpsertInput,
} from './meeting-repository.js';

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
/** Below this share of an async speaker's own overlapped time, a live identity is NOT carried forward (risk table: "a name lands on the wrong cluster"). The async speaker stays unnamed and the user-named live row is kept, never deleted — nothing is lost, the post-meeting screen can still resolve it. */
const USER_IDENTITY_OVERLAP_FRACTION = 0.6;

export interface AsyncToLiveMapping {
  sessionSpeakerId: string;
  /** This live speaker's overlap with the async speaker, as a share of the async speaker's OWN total segment time. */
  overlapFraction: number;
}

/**
 * PURE (no I/O): maps each async `speakerId` to whichever live
 * `sessionSpeakerId` overlaps its segments the MOST (summed overlap, via
 * `caption-aligner.alignByMaxOverlap`), plus what share of that async
 * speaker's OWN time the overlap covers. Runs BEFORE `resolveSpeakers` (no
 * async `meeting_speakers` rows exist yet at this point) so its result can
 * feed `userIdentityBySpeakerId` into that very pass — see `applyLiveReconciliation`
 * for the DB-writing half that runs AFTER.
 */
export function computeAsyncToLiveMap(segments: readonly Segment[], liveTurns: readonly LiveTurnSpan[]): Map<string, AsyncToLiveMapping> {
  const mapped = new Map<string, AsyncToLiveMapping>();
  if (liveTurns.length === 0) return mapped;

  const asyncSpans = segments.map((s) => ({ startMs: Math.round(s.startSec * 1000), endMs: Math.round(s.endSec * 1000), speakerId: s.speakerId }));
  const totalMsBySpeaker = new Map<string, number>();
  for (const s of asyncSpans) totalMsBySpeaker.set(s.speakerId, (totalMsBySpeaker.get(s.speakerId) ?? 0) + Math.max(0, s.endMs - s.startMs));

  const aligned = alignByMaxOverlap(asyncSpans, liveTurns, { toleranceMs: RECONCILE_TOLERANCE_MS });

  const overlapMsBySpeaker = new Map<string, Map<string, number>>();
  for (const { a, b } of aligned) {
    if (!b) continue;
    const overlapMs = Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs);
    if (overlapMs <= 0) continue;
    const bySession = overlapMsBySpeaker.get(a.speakerId) ?? new Map<string, number>();
    bySession.set(b.speakerKey, (bySession.get(b.speakerKey) ?? 0) + overlapMs);
    overlapMsBySpeaker.set(a.speakerId, bySession);
  }

  for (const [speakerId, bySession] of overlapMsBySpeaker) {
    if (bySession.size === 0) continue;
    const [sessionSpeakerId, overlapMs] = [...bySession.entries()].sort((x, y) => y[1] - x[1])[0];
    const totalMs = totalMsBySpeaker.get(speakerId) ?? 0;
    mapped.set(speakerId, { sessionSpeakerId, overlapFraction: totalMs > 0 ? overlapMs / totalMs : 0 });
  }
  return mapped;
}

/**
 * Derives `resolveSpeakers`'s `userIdentityBySpeakerId` from the async->live
 * mapping + this meeting's live-only rows' OWN identity fields
 * (`loadLiveIdentities`): only a live speaker holding `nameSource:'user'`
 * AND at least {@link USER_IDENTITY_OVERLAP_FRACTION} of the async speaker's
 * overlapped time is carried forward — below that bar, nothing is guessed.
 */
function deriveUserIdentities(
  mapping: ReadonlyMap<string, AsyncToLiveMapping>,
  liveIdentities: ReadonlyMap<string, LiveIdentity>,
  createdByUserId: string,
): Map<string, UserIdentity> {
  const out = new Map<string, UserIdentity>();
  for (const [speakerId, { sessionSpeakerId, overlapFraction }] of mapping) {
    if (overlapFraction < USER_IDENTITY_OVERLAP_FRACTION) continue;
    const identity = liveIdentities.get(sessionSpeakerId);
    if (identity?.nameSource === 'user' && identity.displayName) {
      out.set(speakerId, { displayName: identity.displayName, privosUserId: identity.privosUserId, profileId: identity.profileId, createdByUserId, sessionSpeakerId });
    }
  }
  return out;
}

/**
 * DB-writing half of P5 reconciliation — runs AFTER `upsertMeetingSpeakers`
 * (the async rows now exist) using the SAME mapping `computeAsyncToLiveMap`
 * already produced. Folds each live row's metadata into its matched async
 * row (`mergeLiveIntoAsyncSpeaker` — name priority `user` > `async` > `live`)
 * then deletes live-only rows that never mapped to an async speaker (noise),
 * EXCEPT a `nameSource:'user'` one (`deleteUnmappedLiveSpeakers`'s own
 * guard) — nothing a human confirmed live is ever silently dropped.
 *
 * A `nameSource:'user'` live row is the ONE case `computeAsyncToLiveMap`'s
 * plain max-overlap winner is not good enough for on its own: below
 * {@link USER_IDENTITY_OVERLAP_FRACTION} of the async speaker's own time,
 * folding it in would move that person's name/profile onto a cluster it
 * mostly does NOT belong to (`mergeLiveIntoAsyncSpeaker`'s `user`-outranks-
 * everything name priority would make that stick). So a below-floor
 * `nameSource:'user'` mapping is skipped here entirely — no merge, no
 * `displayName`/`nameSource`/`profileId` moves onto the async row — leaving
 * the live row standalone; `deleteUnmappedLiveSpeakers` already never
 * deletes a `nameSource:'user'` row regardless of the mapped set, so it
 * survives for the post-meeting resolve screen. Every OTHER (non-`user`)
 * live row keeps today's unconditional max-overlap folding — the floor is
 * specifically about human-confirmed identity, not live guesses.
 *
 * Returns the mappings that were ACTUALLY merged (a subset of `mapping`),
 * so the caller's `liveSessionSpeakerId` bookkeeping never claims a merge
 * that was skipped.
 */
async function applyLiveReconciliation(
  db: AppDbBotClient,
  meetingId: string,
  mapping: ReadonlyMap<string, AsyncToLiveMapping>,
  liveIdentities: ReadonlyMap<string, LiveIdentity>,
): Promise<Map<string, string>> {
  const merged = new Map<string, string>();
  for (const [speakerId, { sessionSpeakerId, overlapFraction }] of mapping) {
    const identity = liveIdentities.get(sessionSpeakerId);
    if (identity?.nameSource === 'user' && overlapFraction < USER_IDENTITY_OVERLAP_FRACTION) {
      continue; // below the floor — never fold a human-confirmed identity onto the wrong cluster.
    }
    await mergeLiveIntoAsyncSpeaker(db, meetingId, speakerId, sessionSpeakerId);
    merged.set(speakerId, sessionSpeakerId);
  }
  await deleteUnmappedLiveSpeakers(db, meetingId, new Set(merged.values()));
  return merged;
}

/** Best-effort parse of the model's free-text `due` into an ISO date App DB's `date` field accepts; unparseable text is dropped rather than sent as an invalid date (the task text itself still carries any human phrasing like "this weekend"). */
function parseDueDate(due: string | null): string | undefined {
  if (!due) return undefined;
  const parsed = new Date(due);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

export interface SummarizeStepResult {
  payload: SummaryPayload;
  summaryFileId: string;
  /** Same segments, with `.translation` filled in where the batch translate pass succeeded — feeds the bilingual transcript.json/.md/.srt write. A fresh mutable array (never the caller's own `Segment[]` reference). */
  translatedSegments: Segment[];
}

/**
 * P6 hook: Hub AI translate (optional, D-12 batch path) + map-reduce
 * summarize (D-07) + `summary.md` upload + `action_items` replace, for one
 * meeting's already reconciled/named segments. Throws on any failure — the
 * caller (`runMeetingJob`) treats that as NON-FATAL to the job itself
 * (plan.md: record `meetings.summaryError`, job still `completed`, transcript
 * untouched, audio NOT deleted even when `keepAudio===false`).
 */
export async function summarizeTranscript(input: {
  db: AppDbBotClient;
  hub: RoomBoundHubClient;
  roomId: string;
  folderId: string;
  meetingId: string;
  title: string;
  startedAt: string;
  durationSec: number;
  language: string;
  translationEnabled: boolean;
  translationLang?: string;
  segments: readonly Segment[];
  speakers: readonly JobResultSpeaker[];
  /** Optional — `runMeetingJob` always passes the job's abort signal; a standalone `meeting_summarize` tool call has none to propagate. */
  signal?: AbortSignal;
}): Promise<SummarizeStepResult> {
  const { db, hub, roomId, folderId, meetingId, title, startedAt, durationSec, segments, speakers, signal } = input;

  const displayNameBySpeaker: Record<string, string> = {};
  for (const speaker of speakers) displayNameBySpeaker[speaker.speakerId] = speaker.displayName ?? speaker.speakerId;
  const speakerNames = Object.values(displayNameBySpeaker);

  // Translate first so the map-reduce summarizer and the transcript writers both see `.translation` — a per-batch
  // translate failure is already swallowed inside `translateSegmentsBatch` (skip that batch), never here.
  let translatedSegments = segments;
  const targetLang = isLanguageCode(input.translationLang) ? input.translationLang : undefined;
  if (input.translationEnabled && targetLang) {
    const translations = await translateSegmentsBatch(hub, { roomId, segments, target: targetLang, signal });
    if (translations.size > 0) {
      translatedSegments = segments.map((s) => (translations.has(s.id) ? { ...s, translation: translations.get(s.id) } : s));
    }
  }

  const summaryLanguage = asLanguageCode(input.language);
  const chunks = chunkTranscript(translatedSegments, displayNameBySpeaker);
  const payload = await runSummarizer(hub, { roomId, chunks, language: summaryLanguage, title, speakerNames }, signal);

  const markdown = renderSummaryMarkdown({ title, startedAt, durationSec, speakers: speakerNames, payload, language: summaryLanguage });
  const summaryUpload = await uploadBotFile({
    hub,
    roomId,
    folderId,
    fileName: 'summary.md',
    mimeType: 'text/markdown',
    data: Buffer.from(markdown, 'utf8'),
    duplicateAction: 'replace',
    signal,
  });

  await replaceActionItems(
    db,
    meetingId,
    payload.action_items.map((item) => ({ task: item.task, owner: item.owner, due: parseDueDate(item.due), atSec: item.at ?? undefined })),
  );

  return { payload, summaryFileId: summaryUpload.fileId, translatedSegments: [...translatedSegments] };
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
    // soniox-async tokens carry their own spacing (concatenate); elevenlabs-batch
    // tokens are bare words (join with a space) — see segment-builder options.
    const segments = buildSegments(sttResult.tokens, { pauseSplitSec: 1.5, tokensCarrySpacing: providerVendor === 'soniox' });

    // 5. P4 embed + match/enrol against `speaker_profiles`; P5 reconciles against live-turns.json.
    // Mapping-before-resolve (plan.md § Requirements): the async<->live map and
    // any `nameSource:'user'` live identity it carries are computed BEFORE
    // `resolveSpeakers` runs, so a user-identified speaker skips matching
    // entirely instead of risking an auto-match into the WRONG profile. The
    // live worker is stopped and its registry evicted first so a still-
    // draining chunk cannot `upsertAll` into rows this job is about to
    // reconcile (KeyedSerialQueue.abort awaits the actual stop).
    await abortMeetingQueue(job.meetingId);
    sessionRegistries.delete(job.meetingId);
    const meetingRow = await db.getById('meetings', 'room', job.meetingId);
    const meetingOwnerUserId = typeof meetingRow?.ownerUserId === 'string' && meetingRow.ownerUserId ? meetingRow.ownerUserId : 'unknown';
    const liveTurnsFile = await readLiveTurns(agentBotHub, roomId, folderId);
    const asyncToLiveMap = computeAsyncToLiveMap(segments, liveTurnsFile?.turns ?? []);
    const liveIdentities = await loadLiveIdentities(db, job.meetingId);
    const userIdentityBySpeakerId = deriveUserIdentities(asyncToLiveMap, liveIdentities, meetingOwnerUserId);

    await jobRepo.patch(job._id, { step: 'embed', progress: 0.7 });
    const resolved = await resolveSpeakersEmbed(db, wavPath, segments, job.meetingId, userIdentityBySpeakerId);
    const speakerUpserts: SpeakerUpsertInput[] = resolved.map((s, i) => ({
      speakerId: s.speakerId,
      totalSpeakSec: s.totalSpeakSec,
      nameSource: s.nameSource ?? (s.resolved ? ('async' as const) : undefined),
      sampleStartSec: s.sampleRange?.startSec,
      sampleEndSec: s.sampleRange?.endSec,
      profileId: s.profileId,
      // plan.md § Requirements: unmatched speakers keep the numbered placeholder until `speaker_resolve` confirms a real name.
      displayName: s.resolved ? s.displayName : `Speaker ${i + 1}`,
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
    const liveSessionSpeakerIds = await applyLiveReconciliation(db, job.meetingId, asyncToLiveMap, liveIdentities);
    for (const speaker of speakers) {
      const sessionSpeakerId = liveSessionSpeakerIds.get(speaker.speakerId);
      if (sessionSpeakerId) speaker.liveSessionSpeakerId = sessionSpeakerId;
    }

    const languageCode = sttResult.language ?? job.language;
    const durationSec = Math.round(decoded.durationSec);
    const displayNameBySpeaker: Record<string, string> = Object.fromEntries(speakers.map((s) => [s.speakerId, s.displayName ?? s.speakerId]));

    // 6. P6 translate (optional) + map-reduce summarize via Hub AI. Non-fatal: a failure here is recorded as
    // `meetings.summaryError` and the job still completes with the transcript intact (plan.md § Requirements).
    await jobRepo.patch(job._id, { step: 'summarize', progress: 0.75 });
    const translationEnabled = meetingRow?.translationEnabled === true;
    const translationLang = typeof meetingRow?.translationLang === 'string' ? meetingRow.translationLang : undefined;

    let summarized: SummarizeStepResult | undefined;
    let summaryError: string | undefined;
    try {
      summarized = await summarizeTranscript({
        db,
        hub: agentBotHub,
        roomId,
        folderId,
        meetingId: job.meetingId,
        title: job.title,
        startedAt: job.startedAt,
        durationSec,
        language: job.language,
        translationEnabled,
        translationLang,
        segments,
        speakers,
        signal,
      });
    } catch (error) {
      summaryError = error instanceof Error ? error.message : String(error);
      console.warn('[meeting-job] summarize/translate failed (transcript is kept, job still completes):', summaryError);
    }
    const finalSegments = summarized?.translatedSegments ?? segments;

    // 7. write transcript.json/.md/.srt (bilingual when translated) to Files.
    await jobRepo.patch(job._id, { step: 'write', progress: 0.9 });
    const transcriptDoc = buildTranscriptJson({
      meetingId: job.meetingId,
      title: job.title,
      startedAt: job.startedAt,
      durationSec,
      languageCode,
      translationLang: summarized ? translationLang : undefined,
      provider: job.sttProvider,
      speakers: speakers.map((s) => ({ speakerId: s.speakerId, totalSpeakSec: s.totalSpeakSec, displayName: s.displayName ?? null })),
      segments: finalSegments,
      tokens: sttResult.tokens,
    });
    const markdown = buildTranscriptMarkdown({
      title: job.title,
      startedAt: job.startedAt,
      durationSec,
      languageCode,
      provider: job.sttProvider,
      segments: finalSegments,
      displayNameBySpeaker,
    });
    const srt = buildSrt(finalSegments, sttResult.tokens, providerVendor === 'soniox');

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
      ...(summarized ? { summaryFileId: summarized.summaryFileId, summaryText: summarized.payload.summary.slice(0, 20_000), keyTopics: summarized.payload.key_topics } : {}),
      // Clears a PREVIOUS run's summaryError on success, records this run's on failure — always a fresh write, never stale.
      summaryError: summaryError ?? '',
    });

    // 8. cleanup — delete audio.webm ONLY when keepAudio===false AND summarize succeeded (plan.md: never delete the
    // only remaining source of truth when the AI step failed, even if the user opted out of keeping audio).
    await jobRepo.patch(job._id, { step: 'cleanup', progress: 0.98 });
    if (!job.keepAudio && summarized) {
      await deleteRoomFile(agentBotHub, audioUpload.fileId, signal)
        .then(() => upsertMeeting(db, job.meetingId, { audioDeletedAt: new Date().toISOString() }))
        .catch((error) => {
          console.warn('[meeting-job] failed to delete audio.webm (does not block job completion):', error instanceof Error ? error.message : error);
        });
    }

    await jobRepo.finish(job._id, {
      durationSec,
      languageCode,
      sttProvider: job.sttProvider,
      speakers,
      fileIds: { transcriptJson: jsonUpload.fileId, transcriptMd: mdUpload.fileId, srt: srtUpload.fileId, summary: summarized?.summaryFileId },
      summary: summarized?.payload,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[meeting-job] failed', { jobId: job.jobId, meetingId: job.meetingId, error: message, stack: error instanceof Error ? error.stack : undefined });
    await jobRepo.fail(job._id, message);
    await db.update('meetings', 'room', job.meetingId, { status: 'failed', summaryError: message.slice(0, 4000) }).catch(() => undefined);
    throw error instanceof Error ? error : new AppError(message);
  } finally {
    clearInterval(heartbeat);
    // Runs on BOTH success and failure — the logs from a job that just failed matter most (plan.md § diagnostics).
    await uploadRoomCopy(agentBotHub, roomId, folderId, job.meetingId);
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}
