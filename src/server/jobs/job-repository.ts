/**
 * `processing_jobs` is the ONLY job state — no local `data/jobs/` file store.
 * Every access goes through `AppDbBotClient` (installation bot). Unique index
 * on `meetingId` (schema) is what makes `claim()` idempotent: a second
 * `meeting_process` call for the same meeting reuses this same row.
 */
import { AppError } from '../../shared/app-error.js';
import { extractDbRecords, type AppDbBotClient, type DbRow } from '../hub/app-db-bot-client.js';

export type JobStep = 'download' | 'decode' | 'transcribe' | 'segment' | 'embed' | 'summarize' | 'write' | 'cleanup';
export const JOB_STEPS: readonly JobStep[] = ['download', 'decode', 'transcribe', 'segment', 'embed', 'summarize', 'write', 'cleanup'];

/** How often `meeting-job.ts` pings `heartbeatAt` while a single step runs long. Single source for both the timer and `meeting_status`'s `stale` threshold. */
export const HEARTBEAT_INTERVAL_MS = 15_000;
/** `stale = now - heartbeatAt > 2 × heartbeat cycle` (spec). Informational only — drives the UI's "Xử lý lại" prompt, not `job-repository.sweepStale`'s own (more conservative) reset threshold. */
export const STALE_AFTER_MS = HEARTBEAT_INTERVAL_MS * 2;

export type SttAsyncProviderName = 'soniox-async' | 'elevenlabs-batch';
export type JobStatus = 'queued' | 'processing' | 'completed' | 'failed';

export interface JobResultSpeaker {
  speakerId: string;
  totalSpeakSec: number;
  sampleSec?: number;
  displayName?: string | null;
  profileId?: string;
  confidence?: number;
  resolved?: boolean;
  liveSessionSpeakerId?: string;
  sampleRange?: { startSec: number; endSec: number };
}

export interface JobResult {
  durationSec: number;
  languageCode: string;
  sttProvider: SttAsyncProviderName;
  /** No embedding vector — never store or return one from a job result (QĐ-06). */
  speakers: JobResultSpeaker[];
  fileIds: { transcriptJson: string; transcriptMd: string; srt: string; summary?: string };
  summary?: unknown;
}

export interface JobRecord {
  _id: string;
  jobId: string;
  meetingId: string;
  roomId: string;
  partFileIds: string[];
  audioFileId?: string;
  sttProvider: SttAsyncProviderName;
  providerFileId?: string;
  providerTranscriptionId?: string;
  language: string;
  title: string;
  keepAudio: boolean;
  status: JobStatus;
  step: JobStep | null;
  progress: number;
  error?: string;
  startedAt: string;
  heartbeatAt: string;
  finishedAt?: string;
  result?: JobResult;
}

export interface ClaimInput {
  meetingId: string;
  roomId: string;
  partFileIds: string[];
  sttProvider: SttAsyncProviderName;
  language: string;
  title: string;
  keepAudio: boolean;
}

const COLLECTION = 'processing_jobs';
const SCOPE = 'room' as const;

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function fromRow(row: DbRow): JobRecord {
  let result: JobResult | undefined;
  const resultJson = optionalString(row.resultJson);
  if (resultJson) {
    try {
      result = JSON.parse(resultJson) as JobResult;
    } catch {
      result = undefined;
    }
  }
  const status: JobStatus = row.status === 'processing' || row.status === 'completed' || row.status === 'failed' ? row.status : 'queued';
  const step = typeof row.step === 'string' && (JOB_STEPS as readonly string[]).includes(row.step) ? (row.step as JobStep) : null;

  return {
    _id: row._id,
    jobId: String(row.jobId ?? ''),
    meetingId: String(row.meetingId ?? ''),
    roomId: String(row.roomId ?? ''),
    partFileIds: toStringArray(row.partFileIds),
    audioFileId: optionalString(row.audioFileId),
    sttProvider: row.sttProvider === 'elevenlabs-batch' ? 'elevenlabs-batch' : 'soniox-async',
    providerFileId: optionalString(row.providerFileId),
    providerTranscriptionId: optionalString(row.providerTranscriptionId),
    language: typeof row.language === 'string' && row.language ? row.language : 'vi',
    title: typeof row.title === 'string' ? row.title : '',
    keepAudio: row.keepAudio !== false,
    status,
    step,
    progress: typeof row.progress === 'number' ? row.progress : 0,
    error: optionalString(row.error),
    startedAt: optionalString(row.startedAt) ?? new Date().toISOString(),
    heartbeatAt: optionalString(row.heartbeatAt) ?? new Date().toISOString(),
    finishedAt: optionalString(row.finishedAt),
    result,
  };
}

function newJobId(meetingId: string): string {
  return `job_${meetingId}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export class JobRepository {
  constructor(private readonly db: AppDbBotClient) {}

  async findByMeeting(meetingId: string): Promise<JobRecord | null> {
    const result = await this.db.query(COLLECTION, SCOPE, {
      where: [{ field: 'meetingId', op: '==', value: meetingId }],
      limit: 1,
    });
    const row = extractDbRecords(result)[0];
    return row ? fromRow(row) : null;
  }

  /**
   * Idempotent by `meetingId`: creates a fresh row, or resets an existing
   * failed/stale one back to `queued` IN PLACE (same `jobId` — a client still
   * polling the old id keeps working). `providerFileId`/`providerTranscriptionId`
   * are deliberately preserved across a reset so a retry can resume without
   * re-uploading (S2-12) — the async provider decides whether to use them.
   */
  async claim(input: ClaimInput): Promise<JobRecord> {
    const existing = await this.findByMeeting(input.meetingId);
    const now = new Date().toISOString();
    if (!existing) {
      const created = await this.db.create(COLLECTION, SCOPE, {
        meetingId: input.meetingId,
        roomId: input.roomId,
        jobId: newJobId(input.meetingId),
        partFileIds: input.partFileIds,
        sttProvider: input.sttProvider,
        language: input.language,
        title: input.title,
        keepAudio: input.keepAudio,
        status: 'queued',
        // The Hub's validator rejects `null` for a string field ("Document failed
        // validation") — an empty string is the "no step yet" value; `fromRow` reads it back as null.
        step: '',
        progress: 0,
        startedAt: now,
        heartbeatAt: now,
      });
      return fromRow(created as DbRow);
    }

    await this.db.update(COLLECTION, SCOPE, existing._id, {
      partFileIds: input.partFileIds,
      sttProvider: input.sttProvider,
      language: input.language,
      title: input.title,
      keepAudio: input.keepAudio,
      status: 'queued',
      step: '',
      progress: 0,
      error: '',
      resultJson: '',
      startedAt: now,
      heartbeatAt: now,
      finishedAt: '',
    });
    const reset = await this.findByMeeting(input.meetingId);
    if (!reset) throw new AppError('Không đọc lại được job vừa reset.');
    return reset;
  }

  /** Transition `queued` -> `processing`, the first thing `meeting-job.ts` does — makes `sweepStale` meaningful. */
  async markProcessing(id: string): Promise<void> {
    await this.db.update(COLLECTION, SCOPE, id, { status: 'processing', heartbeatAt: new Date().toISOString() });
  }

  /** Best-effort progress write — a Hub hiccup here must not fail the job (`finish`/`fail` are the writes that matter). */
  async patch(
    id: string,
    patch: Partial<Pick<JobRecord, 'step' | 'progress' | 'audioFileId' | 'providerFileId' | 'providerTranscriptionId'>>,
  ): Promise<void> {
    try {
      const data: Record<string, unknown> = { heartbeatAt: new Date().toISOString() };
      if (patch.step !== undefined) data.step = patch.step ?? ''; // never write null: the Hub validator rejects it
      if (patch.progress !== undefined) data.progress = patch.progress;
      if (patch.audioFileId !== undefined) data.audioFileId = patch.audioFileId;
      if (patch.providerFileId !== undefined) data.providerFileId = patch.providerFileId;
      if (patch.providerTranscriptionId !== undefined) data.providerTranscriptionId = patch.providerTranscriptionId;
      await this.db.update(COLLECTION, SCOPE, id, data);
    } catch (error) {
      console.warn('[job-repository] patch best-effort failed:', error instanceof Error ? error.message : error);
    }
  }

  /** Heartbeat-only — cheaper than `patch`, called on an interval while a single step runs long (e.g. an STT poll). */
  async heartbeat(id: string): Promise<void> {
    try {
      await this.db.update(COLLECTION, SCOPE, id, { heartbeatAt: new Date().toISOString() });
    } catch {
      // best-effort
    }
  }

  /** The write that matters — retried, not swallowed. */
  async finish(id: string, result: JobResult): Promise<void> {
    await this.retryWrite(() =>
      this.db.update(COLLECTION, SCOPE, id, {
        status: 'completed',
        step: 'cleanup',
        progress: 1,
        resultJson: JSON.stringify(result),
        finishedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
      }),
    );
  }

  async fail(id: string, message: string): Promise<void> {
    await this.retryWrite(() =>
      this.db.update(COLLECTION, SCOPE, id, {
        status: 'failed',
        error: message.slice(0, 4000),
        finishedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
      }),
    );
  }

  private async retryWrite(fn: () => Promise<unknown>, attempts = 3): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        await fn();
        return;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
      }
    }
    throw lastError instanceof Error ? lastError : new AppError(String(lastError));
  }

  async listQueued(): Promise<JobRecord[]> {
    const result = await this.db.query(COLLECTION, SCOPE, {
      where: [{ field: 'status', op: '==', value: 'queued' }],
      limit: 1000,
    });
    return extractDbRecords(result).map(fromRow);
  }

  /** `processing` jobs whose heartbeat is older than `olderThanMs` -> `failed(interrupted)`. Returns the ones it touched. */
  async sweepStale(olderThanMs: number): Promise<JobRecord[]> {
    const result = await this.db.query(COLLECTION, SCOPE, {
      where: [{ field: 'status', op: '==', value: 'processing' }],
      limit: 1000,
    });
    const rows = extractDbRecords(result).map(fromRow);
    const cutoff = Date.now() - olderThanMs;
    const stale = rows.filter((row) => new Date(row.heartbeatAt).getTime() < cutoff);
    for (const job of stale) {
      await this.fail(job._id, 'interrupted: job xử lý bị gián đoạn (pm2 khởi động lại hoặc mất tiến trình).');
    }
    return stale;
  }
}
