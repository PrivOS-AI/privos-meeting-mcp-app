/**
 * Soniox async transcription (`stt-async-v5`): REST `POST /v1/files` ->
 * `POST /v1/transcriptions` -> poll `GET /v1/transcriptions/{id}` -> fetch
 * `.../transcript` -> normalize tokens. Sends `audio.webm` UNTRANSCODED
 * (`wants` is implicitly "raw webm" — this provider never touches the decoded
 * wav). Field names below (`start_ms`/`end_ms`/`speaker`/`language`,
 * snake_case request body) follow this app's existing confirmed Soniox
 * convention (`soniox-realtime-token.ts`) per plan.md's documented default —
 * open question #2 flags them as UNCONFIRMED by a live async call; `mapToken`
 * is the one seam to adjust once a real response is observed.
 *
 * Remote cleanup ALWAYS runs (own short-lived signal, independent of the
 * job's signal) so a Soniox-side copy never outlives this call, even when the
 * job's own timeout aborts mid-poll (plan.md S2-12). A crash BEFORE this
 * function's `finally` can run — not a graceful abort — is what
 * `resumeProviderFileId`/`resumeProviderTranscriptionId` and the boot sweep
 * exist for.
 */
import { openAsBlob } from 'node:fs';
import { basename } from 'node:path';

import { AppError } from '../../shared/app-error.js';
import { env } from '../env.js';
import type { AsyncSttProvider, ProviderStatus, SttResult, SttToken, TranscribeInput } from './stt-provider.js';

const BASE_URL = 'https://api.soniox.com';
const POLL_INTERVAL_START_MS = 2000;
const POLL_INTERVAL_MAX_MS = 10_000;
const POLL_TIMEOUT_MS = 55 * 60 * 1000;
const CLEANUP_TIMEOUT_MS = 15_000;
const RETRY_ATTEMPTS = 3;

class SonioxHttpError extends AppError {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function authHeaders(): Record<string, string> {
  return { authorization: `Bearer ${env.sonioxApiKey}` };
}

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 429;
}

async function withRetry<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (signal?.aborted) throw error;
      const retryable = !(error instanceof SonioxHttpError) || isRetryableStatus(error.status);
      if (!retryable || attempt === RETRY_ATTEMPTS - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }
  throw lastError instanceof Error ? lastError : new AppError(String(lastError));
}

async function uploadFile(filePath: string, signal?: AbortSignal): Promise<string> {
  const blob = await openAsBlob(filePath, { type: 'audio/webm' });
  const form = new FormData();
  form.append('file', blob, basename(filePath));
  const response = await fetch(`${BASE_URL}/v1/files`, { method: 'POST', headers: authHeaders(), body: form, signal });
  if (!response.ok) throw new SonioxHttpError(response.status, `Soniox từ chối nhận tệp âm thanh (HTTP ${response.status}).`);
  const body = await readJson(response);
  const id = typeof body?.id === 'string' ? body.id : undefined;
  if (!id) throw new AppError('Soniox không trả về id tệp sau khi upload.');
  return id;
}

async function createTranscription(
  fileId: string,
  clientReferenceId: string | undefined,
  languageHints: string[],
  signal?: AbortSignal,
): Promise<{ id: string }> {
  const response = await fetch(`${BASE_URL}/v1/transcriptions`, {
    method: 'POST',
    headers: { ...authHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify({
      file_id: fileId,
      model: env.sonioxAsyncModel,
      language_hints: languageHints,
      enable_speaker_diarization: true,
      enable_language_identification: true,
      ...(clientReferenceId ? { client_reference_id: clientReferenceId } : {}),
    }),
    signal,
  });
  if (!response.ok) throw new SonioxHttpError(response.status, `Soniox từ chối tạo phiên xử lý (HTTP ${response.status}).`);
  const body = await readJson(response);
  const id = typeof body?.id === 'string' ? body.id : undefined;
  if (!id) throw new AppError('Soniox không trả về id phiên xử lý.');
  return { id };
}

async function pollTranscription(id: string, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let interval = POLL_INTERVAL_START_MS;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new AppError('Job đã huỷ trong lúc chờ Soniox xử lý.');
    const response = await fetch(`${BASE_URL}/v1/transcriptions/${encodeURIComponent(id)}`, { headers: authHeaders(), signal });
    if (!response.ok) throw new SonioxHttpError(response.status, `Soniox trả lỗi khi kiểm tra tiến trình (HTTP ${response.status}).`);
    const body = await readJson(response);
    const status = typeof body?.status === 'string' ? body.status : 'unknown';
    if (status === 'completed') return;
    if (status === 'error') {
      const message = typeof body?.error_message === 'string' ? body.error_message : 'Soniox báo lỗi xử lý không rõ nguyên nhân.';
      throw new AppError(`Soniox xử lý thất bại: ${message}`);
    }
    if (signal?.aborted) throw new AppError('Job đã huỷ trong lúc chờ Soniox xử lý.');
    await new Promise((resolve) => setTimeout(resolve, interval));
    interval = Math.min(interval * 1.5, POLL_INTERVAL_MAX_MS);
  }
  throw new AppError('Soniox xử lý quá thời gian chờ cho phép.');
}

function mapToken(raw: Record<string, unknown>): SttToken | null {
  const startMs = Number(raw.start_ms);
  const endMs = Number(raw.end_ms);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  return {
    text: typeof raw.text === 'string' ? raw.text : '',
    startMs,
    endMs,
    speaker: typeof raw.speaker === 'string' ? raw.speaker : undefined,
    language: typeof raw.language === 'string' ? raw.language : undefined,
    confidence: typeof raw.confidence === 'number' ? raw.confidence : undefined,
    isFinal: true,
  };
}

async function fetchTranscript(id: string, signal?: AbortSignal): Promise<{ tokens: SttToken[]; languageCode?: string }> {
  const response = await fetch(`${BASE_URL}/v1/transcriptions/${encodeURIComponent(id)}/transcript`, { headers: authHeaders(), signal });
  if (!response.ok) throw new SonioxHttpError(response.status, `Soniox trả lỗi khi lấy kết quả (HTTP ${response.status}).`);
  const body = await readJson(response);
  const rawTokens = Array.isArray(body?.tokens) ? (body!.tokens as Record<string, unknown>[]) : [];
  const tokens = rawTokens.map(mapToken).filter((t): t is SttToken => t !== null);
  const languageCode = typeof body?.language === 'string' ? body.language : undefined;
  return { tokens, languageCode };
}

/** Best-effort, own short-lived signal — runs even when the job's own signal is already aborted. */
async function cleanup(fileId: string | undefined, transcriptionId: string | undefined): Promise<void> {
  if (!fileId && !transcriptionId) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLEANUP_TIMEOUT_MS);
  try {
    if (transcriptionId) {
      await fetch(`${BASE_URL}/v1/transcriptions/${encodeURIComponent(transcriptionId)}`, {
        method: 'DELETE',
        headers: authHeaders(),
        signal: controller.signal,
      }).catch(() => undefined);
    }
    if (fileId) {
      await fetch(`${BASE_URL}/v1/files/${encodeURIComponent(fileId)}`, {
        method: 'DELETE',
        headers: authHeaders(),
        signal: controller.signal,
      }).catch(() => undefined);
    }
  } finally {
    clearTimeout(timer);
  }
}

export const sonioxAsyncProvider: AsyncSttProvider = {
  vendor: 'soniox',

  async transcribeFile(input: TranscribeInput): Promise<SttResult> {
    if (!env.sonioxApiKey) throw new AppError('Thiếu SONIOX_API_KEY — không chạy được soniox-async.');
    const languageHints = input.languageHints?.length ? input.languageHints : ['vi', 'en'];

    let fileId = input.resumeProviderFileId;
    let transcriptionId = input.resumeProviderTranscriptionId;
    try {
      if (!transcriptionId) {
        if (!fileId) {
          fileId = await withRetry(() => uploadFile(input.audioPath, input.signal), input.signal);
          await input.onProviderIds?.({ providerFileId: fileId });
        }
        const created = await withRetry(
          () => createTranscription(fileId!, input.clientReferenceId, languageHints, input.signal),
          input.signal,
        );
        transcriptionId = created.id;
        await input.onProviderIds?.({ providerFileId: fileId, providerTranscriptionId: transcriptionId });
      }

      await pollTranscription(transcriptionId, input.signal);
      const { tokens, languageCode } = await fetchTranscript(transcriptionId, input.signal);
      return { tokens, segments: [], language: languageCode };
    } finally {
      await cleanup(fileId, transcriptionId);
    }
  },

  async status(): Promise<ProviderStatus> {
    const configured = Boolean(env.sonioxApiKey);
    return {
      provider: 'soniox',
      kind: 'async',
      configured,
      ok: configured,
      models: [env.sonioxAsyncModel],
      detail: configured ? undefined : 'Thiếu SONIOX_API_KEY.',
    };
  },
};
