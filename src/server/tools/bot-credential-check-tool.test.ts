import { describe, expect, it, vi } from 'vitest';
import type { ToolCallContext } from '@privos_ai/app-server';

import { botCredentialCheckTool } from './bot-credential-check-tool.js';

const person: ToolCallContext = { transport: 'direct', identityState: 'verified', sessionScope: 'test', actor: { userId: 'u1', roomId: 'room-1', claims: {}, provenance: 'user-token' } };
const as = (over: Record<string, unknown>): ToolCallContext => ({ ...person, actor: { ...person.actor!, ...over } as never });

function runtime() {
  const authorizedFetch = vi.fn(async () => new Response(JSON.stringify({ _id: 'bot-1', username: 'meeting.bot' }), { status: 200 }));
  return { runtime: { agentBotHub: { authorizedFetch } } as never, authorizedFetch };
}

describe('meeting_agent_bot_credential_check', () => {
  it("reports the bot's status to a person in a room", async () => {
    const { runtime: rt, authorizedFetch } = runtime();
    await expect(botCredentialCheckTool.execute({}, person, rt)).resolves.toEqual({ status: 'valid', botId: 'bot-1', username: 'meeting.bot' });
    expect(authorizedFetch).toHaveBeenCalledTimes(1);
  });

  it('asks the Hub nothing for an unverified caller, an agent, another app, or a call without a signed room', async () => {
    const { runtime: rt, authorizedFetch } = runtime();
    await expect(botCredentialCheckTool.execute({}, { transport: 'direct', identityState: 'missing', sessionScope: 'test' }, rt)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(botCredentialCheckTool.execute({}, as({ principalType: 'bot' }), rt)).rejects.toMatchObject({ code: 'CALLER_NOT_ALLOWED' });
    await expect(botCredentialCheckTool.execute({}, as({ callerApp: 'ai.privos.other' }), rt)).rejects.toMatchObject({ code: 'CALLER_NOT_ALLOWED' });
    await expect(botCredentialCheckTool.execute({}, as({ roomId: undefined }), rt)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(authorizedFetch).not.toHaveBeenCalled();
  });
});
