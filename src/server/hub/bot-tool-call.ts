/**
 * Shared transport for this app's own `mcpapp.db.*` (and later `mcpapp.bot.*`)
 * App Platform tool calls, made AS THIS APP'S INSTALLATION BOT via
 * `POST /api/v1/mcp-apps.tool-call`. The mediated `app.callServerTool()` bridge
 * the frontend uses always runs as the current user; this backend path
 * authenticates the caller with the app's own agent-bot header credential, so
 * the "user" the Hub resolves grants for IS the bot's own account.
 *
 * `roomId` is OPTIONAL. Only collections registered with `scope:'room'` need it;
 * `scope:'global'` collections (speaker_profiles, app_settings) register and
 * read room-lessly (mcp-apps.ts:2495 `roomId?: string`, verified QĐ-05).
 */
import { createAgentBotHubClient } from '@privos_ai/app-server';

import { AppError } from '../../shared/app-error.js';
import { resolveHubOrigin } from './resolve-hub-origin.js';
import { resolveOwnMcpAppId } from './resolve-own-mcp-app-id.js';

const TOOL_CALL_PATH = '/api/v1/mcp-apps.tool-call';

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * Call one App Platform tool as this app's own installation bot. Throws
 * {@link AppError} with a Hub-provided or transport-provided message on any
 * failure — callers let it propagate to the tool-call error path. Never logs
 * or returns the credential.
 */
export async function callAppPlatformTool(
  toolName: string,
  args: Record<string, unknown>,
  requiredScope: string,
  roomId?: string,
): Promise<unknown> {
  const mcpAppId = await resolveOwnMcpAppId();
  if (!mcpAppId) {
    throw new AppError(
      'Chưa phân giải được mcpAppId của ứng dụng — không gọi được App Platform. '
        + 'Ở chế độ development, chạy lại `npm run pair` (hoặc `npm run dev`) để cache có MCP_APP_ID.',
    );
  }

  const roomHub = createAgentBotHubClient({ resolveHubOrigin });
  const response = await roomHub.authorizedFetch(TOOL_CALL_PATH, {
    method: 'POST',
    requiredScope,
    retryMode: 'never',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mcpAppId, toolName, arguments: args, ...(roomId ? { roomId } : {}) }),
  });

  const raw = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    parsed = {};
  }
  if (!response.ok || parsed.success === false) {
    const reason = typeof parsed.error === 'string' ? parsed.error : `HTTP ${response.status}`;
    throw new AppError(`${toolName} failed: ${reason}`);
  }

  const content = Array.isArray(parsed.content) ? parsed.content : [];
  const first = asRecord(content[0]);
  if (typeof first.text !== 'string') {
    throw new AppError(`${toolName} returned a malformed tool result`);
  }
  try {
    return JSON.parse(first.text);
  } catch {
    throw new AppError(`${toolName} result is not valid JSON`);
  }
}
