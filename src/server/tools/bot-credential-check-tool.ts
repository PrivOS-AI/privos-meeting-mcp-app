/**
 * `meeting_agent_bot_credential_check` — surfaces the installation-bot
 * credential self-check to the iframe so it can show a setup banner. Never
 * returns the credential value, only status and (on success) the bot's public
 * id/username.
 */
import { checkAgentBotCredential } from '../hub/agent-bot-credential-check.js';
import type { AppTool } from './registry.js';

export const botCredentialCheckTool: AppTool = {
  name: 'meeting_agent_bot_credential_check',
  title: 'Kiểm tra credential bot',
  description: 'Kiểm tra thông tin xác thực của bot cài đặt với Hub.',
  inputSchema: { type: 'object', properties: {} },
  async execute() {
    const result = await checkAgentBotCredential();
    if (result.status === 'valid') {
      return { status: 'valid', botId: result.botId, username: result.username };
    }
    return { status: result.status };
  },
};
