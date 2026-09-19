/**
 * Hub AI (Sandbox agent) client — the ONLY summarization/translation backend
 * this app calls (QĐ-07). No third-party LLM key: the same installation-bot
 * credential already used for `mcpapp.db.*` also carries `agents.sandbox.*`,
 * so this reuses `ToolRuntime.agentBotHub` (`RoomBoundHubClient`) instead of a
 * second transport.
 *
 * `agents.sandbox.generate`/`generate-async` are REST endpoints, NOT
 * `mcpapp.db.*`-style tools — called directly, unlike `bot-tool-call.ts`'s
 * `mcp-apps.tool-call` proxy which only fronts `mcpapp.db.*` / `mcpapp.bot.*` /
 * `mcpapp.context.get` / `mcpapp.app.*` (`mcp-app-platform/apis/rest-tool-call.md`).
 *
 * `generate` (P2) is the synchronous path used by `meeting_translate`'s 3-5s
 * live batch window. `generateAsyncWithHubAi` (P6) is for long summarize/
 * translate-batch payloads: POST `generate-async` → `{ attemptId }`, then poll
 * `attempt-status` until terminal.
 *
 * OPEN QUESTION (plan.md risk table + `auth-and-rest-integration.md:59-74,
 * 99-147`, not present in this repo — external Hub dev-doc): the exact
 * `generate-async`/`attempt-status` response shape has never been observed
 * against a live Hub (spike-05 is unresolved offline). The field names below
 * (`attemptId`, `status`, `text`/`result`/`output`, terminal state strings)
 * are this phase's best-guess DEFAULT, written tolerantly (accepts several
 * plausible shapes) and isolated to `parseAttemptStatus`/the two `asRecord`
 * extractions below so a future correction is a one-function fix once the
 * spike runs live.
 */
import type { RoomBoundHubClient } from '@privos_ai/app-server';

import { AppError } from '../../shared/app-error.js';
import { env } from '../env.js';

const GENERATE_PATH = '/api/v1/agents.sandbox.generate';
const GENERATE_ASYNC_PATH = '/api/v1/agents.sandbox.generate-async';
const ATTEMPT_STATUS_PATH = '/api/v1/agents.sandbox.attempt-status';

/** Hard caps documented in auth-and-rest-integration.md:114 — shared by every chunker/summarizer/translator that budgets Hub AI payload size. */
export const PROMPT_LIMIT = 50_000;
export const SYSTEM_LIMIT = 200_000;

/** Poll backoff for `attempt-status`: starts at 1s, doubles up to a 5s ceiling (plan.md § Non-functional). */
const POLL_START_MS = 1_000;
const POLL_MAX_MS = 5_000;
/** Safety net independent of the caller's own `signal`/job timeout — ~10 minutes of polling before giving up outright. */
const POLL_MAX_ATTEMPTS = 150;

export interface HubAiGenerateInput {
  roomId: string;
  prompt: string;
  systemContext?: string;
  model?: string;
  /** Which configured provider/model pair to use — translation may run on a cheaper, faster model. Default 'summary'. */
  purpose?: 'summary' | 'translate';
}

/** Provider/model for this call: explicit `model` wins, then the purpose's env pair, then the summary pair, then the Hub default (nothing sent). */
function resolveModelChoice(input: HubAiGenerateInput): { provider?: string; model?: string } {
  if (input.model) return { model: input.model };
  if (input.purpose === 'translate' && env.translateModel) {
    return { provider: env.translateProvider, model: env.translateModel };
  }
  return { provider: env.summaryProvider, model: env.summaryModel };
}

export interface HubAiGenerateResult {
  text: string;
  source: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function validateGenerateInput(input: HubAiGenerateInput): void {
  if (!input.prompt || input.prompt.length >= PROMPT_LIMIT) {
    throw new AppError('Nội dung gửi Hub AI trống hoặc vượt quá giới hạn cho phép.');
  }
  if (input.systemContext && input.systemContext.length >= SYSTEM_LIMIT) {
    throw new AppError('Ngữ cảnh hệ thống gửi Hub AI vượt quá giới hạn cho phép.');
  }
}

async function readJsonBody(response: Response): Promise<Record<string, unknown>> {
  const raw = await response.text();
  try {
    return raw ? asRecord(JSON.parse(raw)) : {};
  } catch {
    return {};
  }
}

/** One-shot, blocking Hub AI generation as the installation bot. Never logs the prompt/response. */
export async function generateWithHubAi(hub: RoomBoundHubClient, input: HubAiGenerateInput): Promise<HubAiGenerateResult> {
  validateGenerateInput(input);
  const { provider, model } = resolveModelChoice(input);
  let response: Response;
  try {
    response = await hub.authorizedFetch(GENERATE_PATH, {
      method: 'POST',
      requiredScope: 'sandbox:generate',
      retryMode: 'never',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        roomId: input.roomId,
        prompt: input.prompt,
        ...(input.systemContext ? { systemContext: input.systemContext } : {}),
        ...(provider ? { provider } : {}),
        ...(model ? { model } : {}),
      }),
    });
  } catch {
    throw new AppError('Không gọi được Hub AI — vui lòng thử lại sau.');
  }

  const parsed = await readJsonBody(response);
  if (!response.ok) {
    const reason = typeof parsed.error === 'string' ? parsed.error : `HTTP ${response.status}`;
    throw new AppError(`Hub AI trả lỗi: ${reason}`);
  }
  if (typeof parsed.text !== 'string') {
    throw new AppError('Hub AI trả về dữ liệu không hợp lệ.');
  }
  return { text: parsed.text, source: typeof parsed.source === 'string' ? parsed.source : 'unknown' };
}

const SUCCESS_STATES = new Set(['completed', 'succeeded', 'success', 'done', 'finished']);
const FAILURE_STATES = new Set(['failed', 'error', 'errored', 'cancelled', 'canceled', 'timeout']);

/** Tolerant extraction of the generated text from an attempt-status body — see module header OPEN QUESTION. */
function extractAttemptText(parsed: Record<string, unknown>): string | undefined {
  if (typeof parsed.text === 'string') return parsed.text;
  if (typeof parsed.result === 'string') return parsed.result;
  if (typeof parsed.output === 'string') return parsed.output;
  const data = asRecord(parsed.data);
  if (typeof data.text === 'string') return data.text;
  const result = asRecord(parsed.result);
  if (typeof result.text === 'string') return result.text;
  return undefined;
}

function extractAttemptStatus(parsed: Record<string, unknown>): string {
  return typeof parsed.status === 'string' ? parsed.status.toLowerCase() : '';
}

function extractAttemptError(parsed: Record<string, unknown>): string | undefined {
  if (typeof parsed.error === 'string') return parsed.error;
  const err = asRecord(parsed.error);
  if (typeof err.message === 'string') return err.message;
  return undefined;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AppError('Yêu cầu Hub AI đã bị huỷ.'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new AppError('Yêu cầu Hub AI đã bị huỷ.'));
      },
      { once: true },
    );
  });
}

/**
 * Long-running Hub AI generation: POST `generate-async` for an `attemptId`,
 * then poll `attempt-status` with 1s→5s backoff until a terminal state,
 * aborting immediately when `signal` fires (so a job timeout can cut this
 * off). Never logs the prompt/response/attemptId contents.
 */
export async function generateAsyncWithHubAi(
  hub: RoomBoundHubClient,
  input: HubAiGenerateInput,
  signal?: AbortSignal,
): Promise<HubAiGenerateResult> {
  validateGenerateInput(input);
  const { provider, model } = resolveModelChoice(input);

  let startResponse: Response;
  try {
    startResponse = await hub.authorizedFetch(GENERATE_ASYNC_PATH, {
      method: 'POST',
      requiredScope: 'sandbox:generate',
      retryMode: 'never',
      signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        roomId: input.roomId,
        prompt: input.prompt,
        ...(input.systemContext ? { systemContext: input.systemContext } : {}),
        ...(provider ? { provider } : {}),
        ...(model ? { model } : {}),
      }),
    });
  } catch {
    throw new AppError('Không gọi được Hub AI (generate-async) — vui lòng thử lại sau.');
  }

  const startBody = await readJsonBody(startResponse);
  if (!startResponse.ok) {
    const reason = typeof startBody.error === 'string' ? startBody.error : `HTTP ${startResponse.status}`;
    throw new AppError(`Hub AI trả lỗi khi khởi tạo: ${reason}`);
  }
  const attemptId = typeof startBody.attemptId === 'string' ? startBody.attemptId : typeof startBody.id === 'string' ? startBody.id : undefined;
  if (!attemptId) {
    throw new AppError('Hub AI không trả về attemptId.');
  }

  let backoffMs = POLL_START_MS;
  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    await sleep(backoffMs, signal);
    backoffMs = Math.min(backoffMs * 2, POLL_MAX_MS);

    let pollResponse: Response;
    try {
      pollResponse = await hub.authorizedFetch(`${ATTEMPT_STATUS_PATH}?attemptId=${encodeURIComponent(attemptId)}`, {
        method: 'GET',
        requiredScope: 'sandbox:generate',
        retryMode: 'never',
        signal,
      });
    } catch {
      throw new AppError('Không kiểm tra được trạng thái Hub AI — vui lòng thử lại sau.');
    }

    const pollBody = await readJsonBody(pollResponse);
    if (!pollResponse.ok) {
      const reason = typeof pollBody.error === 'string' ? pollBody.error : `HTTP ${pollResponse.status}`;
      throw new AppError(`Hub AI trả lỗi khi kiểm tra tiến độ: ${reason}`);
    }

    const status = extractAttemptStatus(pollBody);
    if (FAILURE_STATES.has(status)) {
      throw new AppError(`Hub AI xử lý thất bại: ${extractAttemptError(pollBody) ?? status}`);
    }
    if (SUCCESS_STATES.has(status)) {
      const text = extractAttemptText(pollBody);
      if (typeof text !== 'string') {
        throw new AppError('Hub AI trả về dữ liệu không hợp lệ.');
      }
      return { text, source: typeof pollBody.source === 'string' ? pollBody.source : 'unknown' };
    }
    // queued/processing/unknown — keep polling.
  }

  throw new AppError('Hub AI xử lý quá lâu — vui lòng thử lại sau.');
}
