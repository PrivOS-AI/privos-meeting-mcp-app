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
 * read room-lessly (mcp-apps.ts:2495 `roomId?: string`, verified D-05).
 *
 * The Hub resolves a bot call's scopes from the BOT's own binding in the room,
 * so a bot that is not a member gets `Insufficient scope` for every scope even
 * when the admin granted them all. On that refusal this module probes the
 * scope-free `mcpapp.context.get` in the same room: `Not allowed` / `not active
 * for this caller` means the bot is outside the room (`ASSISTANT_NOT_IN_ROOM`,
 * fix: add it), anything else is a real grant gap (`PERMISSION_NOT_GRANTED`,
 * fix: Admin > Apps). Other failures never probe.
 */
import { createAgentBotHubClient } from '@privos_ai/app-server';

import { AppError } from '../../shared/app-error.js';
import { manifest } from '../manifest.js';
import { resolveHubOrigin } from './resolve-hub-origin.js';
import { resolveOwnMcpAppId } from './resolve-own-mcp-app-id.js';

const TOOL_CALL_PATH = '/api/v1/mcp-apps.tool-call';
const PROBE_TOOL = 'mcpapp.context.get';
const BOT_SLUG = manifest.agentBot.slug;

type BotHub = ReturnType<typeof createAgentBotHubClient>;

async function postToolCall(hub: BotHub, body: Record<string, unknown>, requiredScope: string): Promise<{ ok: boolean; status: number; parsed: Record<string, unknown> }> {
  const response = await hub.authorizedFetch(TOOL_CALL_PATH, {
    method: 'POST',
    requiredScope,
    retryMode: 'never',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    parsed = {};
  }
  return { ok: response.ok && parsed.success !== false, status: response.status, parsed };
}

/** True only when the scope-free probe says the bot has no membership/binding in `roomId`. A probe that cannot run is not evidence. */
async function botIsOutsideRoom(hub: BotHub, mcpAppId: string, roomId: string): Promise<boolean> {
  try {
    const probe = await postToolCall(hub, { mcpAppId, toolName: PROBE_TOOL, arguments: {}, roomId }, 'basic:information');
    const error = typeof probe.parsed.error === 'string' ? probe.parsed.error : '';
    return !probe.ok && /not allowed|not active for this caller/i.test(error);
  } catch {
    return false;
  }
}

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
      "Could not resolve the app's mcpAppId — cannot call the App Platform. "
        + 'In development mode, rerun `npm run pair` (or `npm run dev`) so the cache has MCP_APP_ID.',
    );
  }

  const roomHub = createAgentBotHubClient({ resolveHubOrigin });
  const { ok, status, parsed } = await postToolCall(roomHub, { mcpAppId, toolName, arguments: args, ...(roomId ? { roomId } : {}) }, requiredScope);
  if (!ok) {
    const reason = typeof parsed.error === 'string' ? parsed.error : `HTTP ${status}`;
    if (/insufficient scope/i.test(reason) && roomId && toolName !== PROBE_TOOL) {
      if (await botIsOutsideRoom(roomHub, mcpAppId, roomId)) {
        throw new AppError(
          `The meeting assistant (@${BOT_SLUG}) is not a member of this room yet. Add it to the room — reopening the app does this when you may add it — then try again.`,
          'ASSISTANT_NOT_IN_ROOM',
          { scope: requiredScope, botSlug: BOT_SLUG },
        );
      }
      throw new AppError(
        `This app has not been granted "${requiredScope}" in this workspace. Ask a workspace admin to approve it in Admin > Apps.`,
        'PERMISSION_NOT_GRANTED',
        { scope: requiredScope },
      );
    }
    throw new AppError(`${toolName} failed: ${reason}`, 'HUB_ERROR');
  }

  const content = Array.isArray(parsed.content) ? parsed.content : [];
  const first = asRecord(content[0]);
  if (typeof first.text !== 'string') {
    throw new AppError(`${toolName} returned a malformed tool result`, 'HUB_ERROR');
  }
  try {
    return JSON.parse(first.text);
  } catch {
    throw new AppError(`${toolName} result is not valid JSON`, 'HUB_ERROR');
  }
}
