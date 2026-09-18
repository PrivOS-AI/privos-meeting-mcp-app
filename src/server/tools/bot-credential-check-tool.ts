/**
 * `meeting_agent_bot_credential_check` — surfaces the installation-bot
 * credential status to the iframe so it can show a setup banner. Never returns
 * the credential value, only status and (on success) the bot's public
 * id/username.
 *
 * Checks through `runtime.agentBotHub` (the resolved-mode bot transport), NOT
 * raw env vars: in standalone-production the credential is delivered by the Hub
 * over the pairing/standalone-control channel, so an env-only check would
 * report "not-configured" even though the bot works. `GET /api/v1/me` succeeds
 * for any authenticated bot and carries its own identity.
 */
import type { AppTool } from './registry.js';

interface MeBody {
  _id?: unknown;
  username?: unknown;
}

export const botCredentialCheckTool: AppTool = {
  name: 'meeting_agent_bot_credential_check',
  title: 'Kiểm tra credential bot',
  description: 'Kiểm tra thông tin xác thực của bot cài đặt với Hub.',
  inputSchema: { type: 'object', properties: {} },
  async execute(_args, _context, runtime) {
    try {
      const response = await runtime.agentBotHub.authorizedFetch('/api/v1/me', {
        requiredScope: 'basic:information',
        retryMode: 'never',
      });
      if (!response.ok) return { status: 'invalid', httpStatus: response.status };
      const body = (await response.json().catch(() => null)) as MeBody | null;
      return {
        status: 'valid',
        botId: typeof body?._id === 'string' ? body._id : '',
        username: typeof body?.username === 'string' ? body.username : '',
      };
    } catch (error) {
      // AgentBotCredentialAbsentError → nothing configured/delivered yet;
      // anything else (origin unresolved, network) → Hub unreachable.
      const name = error instanceof Error ? error.name : '';
      if (name === 'AgentBotCredentialAbsentError') return { status: 'not-configured' };
      return { status: 'hub-unreachable' };
    }
  },
};
