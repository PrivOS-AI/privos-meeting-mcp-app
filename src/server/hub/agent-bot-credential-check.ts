/**
 * Self-check for this app's own installation agent-bot credential.
 *
 * The Hub authenticates REST calls from the header pair `x-user-id` +
 * `x-auth-token`. This app declares two reserved env keys that carry them —
 * `PRIVOS_AGENT_BOT_CREDENTIAL` (the token, secret) and
 * `PRIVOS_AGENT_BOT_USER_ID` (the bot's user id) — both set by a workspace admin
 * from Admin > Apps > this app > Settings, never by this app. `GET /api/v1/me`
 * validates: it succeeds only when both headers name an active session, and its
 * body carries the calling identity, which doubles as proof for the UI.
 *
 * This module never returns, logs, or throws the credential value — only
 * presence, the Hub's HTTP outcome, and (on success) the bot's `_id`/`username`.
 */
import { resolveHubOrigin } from './resolve-hub-origin.js';

const VALIDATE_TIMEOUT_MS = 5_000;
const ME_PATH = '/api/v1/me';

export type AgentBotCredentialCheckResult =
  | { status: 'not-configured' }
  | { status: 'hub-unreachable' }
  | { status: 'invalid'; httpStatus: number }
  | { status: 'valid'; botId: string; username: string };

/** Validate the configured agent-bot credential against the Hub's `/api/v1/me`. */
export async function checkAgentBotCredential(): Promise<AgentBotCredentialCheckResult> {
  const token = process.env.PRIVOS_AGENT_BOT_CREDENTIAL;
  const userId = process.env.PRIVOS_AGENT_BOT_USER_ID;
  if (!token || !userId) return { status: 'not-configured' };

  const hubOrigin = await resolveHubOrigin();
  if (!hubOrigin) return { status: 'hub-unreachable' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VALIDATE_TIMEOUT_MS);
  try {
    const response = await fetch(`${hubOrigin}${ME_PATH}`, {
      headers: { 'x-user-id': userId, 'x-auth-token': token },
      signal: controller.signal,
    });
    if (!response.ok) return { status: 'invalid', httpStatus: response.status };

    const body: unknown = await response.json().catch(() => null);
    const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    const botId = typeof record._id === 'string' ? record._id : userId;
    const username = typeof record.username === 'string' ? record.username : '';
    return { status: 'valid', botId, username };
  } catch {
    return { status: 'hub-unreachable' };
  } finally {
    clearTimeout(timer);
  }
}
