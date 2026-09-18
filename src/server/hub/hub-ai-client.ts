/**
 * Hub AI (Sandbox agent) client — the ONLY summarization/translation backend
 * this app calls (QĐ-07). No third-party LLM key: the same installation-bot
 * credential already used for `mcpapp.db.*` also carries `agents.sandbox.*`,
 * so this reuses `ToolRuntime.agentBotHub` (`RoomBoundHubClient`) instead of a
 * second transport.
 *
 * `agents.sandbox.generate` is a REST endpoint, NOT an `mcpapp.db.*`-style tool
 * — it is called directly (`/api/v1/agents.sandbox.generate`), unlike
 * `bot-tool-call.ts`'s `mcp-apps.tool-call` proxy which only fronts
 * `mcpapp.db.*` / `mcpapp.bot.*` / `mcpapp.context.get` / `mcpapp.app.*`
 * (`mcp-app-platform/apis/rest-tool-call.md`).
 *
 * Phase 2 only needs the synchronous `generate` (used by `meeting_translate`'s
 * 3-5s batch window); `generate-async` + `attempt-status` polling for long
 * summaries is P6's addition to this same module.
 */
import type { RoomBoundHubClient } from '@privos_ai/app-server';

import { AppError } from '../../shared/app-error.js';
import { env } from '../env.js';

const GENERATE_PATH = '/api/v1/agents.sandbox.generate';
/** Hard caps documented in auth-and-rest-integration.md:114. */
const PROMPT_MAX_CHARS = 50_000;
const SYSTEM_CONTEXT_MAX_CHARS = 200_000;

export interface HubAiGenerateInput {
  roomId: string;
  prompt: string;
  systemContext?: string;
  model?: string;
}

export interface HubAiGenerateResult {
  text: string;
  source: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

/** One-shot, blocking Hub AI generation as the installation bot. Never logs the prompt/response. */
export async function generateWithHubAi(hub: RoomBoundHubClient, input: HubAiGenerateInput): Promise<HubAiGenerateResult> {
  if (!input.prompt || input.prompt.length >= PROMPT_MAX_CHARS) {
    throw new AppError('Nội dung gửi Hub AI trống hoặc vượt quá giới hạn cho phép.');
  }
  if (input.systemContext && input.systemContext.length >= SYSTEM_CONTEXT_MAX_CHARS) {
    throw new AppError('Ngữ cảnh hệ thống gửi Hub AI vượt quá giới hạn cho phép.');
  }

  const model = input.model ?? env.summaryModel;
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
        ...(model ? { model } : {}),
      }),
    });
  } catch {
    throw new AppError('Không gọi được Hub AI — vui lòng thử lại sau.');
  }

  const raw = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = raw ? asRecord(JSON.parse(raw)) : {};
  } catch {
    parsed = {};
  }
  if (!response.ok) {
    const reason = typeof parsed.error === 'string' ? parsed.error : `HTTP ${response.status}`;
    throw new AppError(`Hub AI trả lỗi: ${reason}`);
  }
  if (typeof parsed.text !== 'string') {
    throw new AppError('Hub AI trả về dữ liệu không hợp lệ.');
  }
  return { text: parsed.text, source: typeof parsed.source === 'string' ? parsed.source : 'unknown' };
}
