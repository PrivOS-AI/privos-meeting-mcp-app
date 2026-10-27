import { describe, expect, it } from 'vitest';
import type { ServeAppHandlerContext, ToolCallContext } from '@privos_ai/app-server';

import { AppError } from '../shared/app-error.js';
import { createMcpHandler } from './mcp-handler.js';
import { registerTool } from './tools/registry.js';

registerTool({
  name: 'test_app_error',
  title: 'Test',
  description: 'Throws an AppError.',
  inputSchema: { type: 'object', properties: {} },
  execute: async () => {
    throw new AppError('Only the meeting owner can perform this action.', 'NOT_MEETING_OWNER', { meetingId: 'm1' });
  },
});
registerTool({
  name: 'test_internal_error',
  title: 'Test',
  description: 'Throws an internal error.',
  inputSchema: { type: 'object', properties: {} },
  execute: async () => {
    throw new Error('secret internal detail');
  },
});

const handler = createMcpHandler({ agentBotHub: {} } as unknown as ServeAppHandlerContext);
const verified: ToolCallContext = { transport: 'direct', identityState: 'verified', sessionScope: 'test', actor: { userId: 'u1', roomId: 'r1', claims: {}, provenance: 'user-token' } };
const call = (name: string, context: ToolCallContext = verified) => handler({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } } as never, context);

describe('mcp-handler tool errors', () => {
  it('returns an AppError as an isError tool result carrying its stable code', async () => {
    await expect(call('test_app_error')).resolves.toEqual({
      isError: true,
      content: [{ type: 'text', text: 'Only the meeting owner can perform this action.' }],
      structuredContent: { error: { code: 'NOT_MEETING_OWNER', message: 'Only the meeting owner can perform this action.', details: { meetingId: 'm1' } } },
    });
  });

  it('rethrows any other error so the SDK hides its message', async () => {
    await expect(call('test_internal_error')).rejects.toThrow('secret internal detail');
  });

  it('refuses an unverified caller with a coded result, before the tool runs', async () => {
    const unverified: ToolCallContext = { transport: 'direct', identityState: 'missing', sessionScope: 'test' };
    await expect(call('test_internal_error', unverified)).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: 'FORBIDDEN' } } });
  });
});
