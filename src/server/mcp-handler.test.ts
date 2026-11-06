import { describe, expect, it, vi } from 'vitest';
import type { ServeAppHandlerContext, ToolCallContext } from '@privos_ai/app-server';

import { AppError } from '../shared/app-error.js';
import { env } from './env.js';
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
/** Calls of the shared tool below that actually ran. */
const ran: Array<Record<string, unknown>> = [];
registerTool({
  name: 'meeting_status',
  title: 'Test',
  description: 'Records that it ran.',
  inputSchema: { type: 'object', properties: {} },
  execute: async (args) => {
    ran.push(args);
    return { ok: true };
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
const call = (name: string, context: ToolCallContext = verified, args: Record<string, unknown> = {}) => handler({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } } as never, context);

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

  it('refuses an agent a tool that is not shared, before the tool runs', async () => {
    const agent: ToolCallContext = { ...verified, actor: { ...verified.actor!, principalType: 'bot' } };
    await expect(call('test_internal_error', agent)).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: 'CALLER_NOT_ALLOWED' } } });
  });

  it('each caller-policy refusal keeps its code, logs one line and never runs the tool', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      ran.length = 0;
      const agent: ToolCallContext = { ...verified, actor: { ...verified.actor!, principalType: 'bot' } };
      const app = (over: Record<string, unknown>): ToolCallContext => ({ ...verified, actor: { ...verified.actor!, callerApp: 'ai.privos.other', ...over } });
      await expect(call('meeting_status', agent, { roomId: 'r2' })).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: 'ROOM_MISMATCH' } } });
      await expect(call('meeting_status', app({}), { roomId: 'r1' })).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: 'CALLER_NOT_ALLOWED' } } });
      env.allowedCallerApps = new Set(['ai.privos.other']);
      await expect(call('meeting_status', app({ crossRoom: true }), { roomId: 'r1' })).resolves.toMatchObject({ isError: true, structuredContent: { error: { code: 'CROSS_ROOM_NOT_ALLOWED' } } });
      expect(ran).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(3);
      expect(error).not.toHaveBeenCalled();

      // The same agent in its own room runs the shared tool, pinned to the signed room.
      await expect(call('meeting_status', agent, {})).resolves.toMatchObject({ content: [{ type: 'text', text: '{"ok":true}' }] });
      expect(ran).toEqual([{ roomId: 'r1' }]);
    } finally {
      env.allowedCallerApps = new Set();
      warn.mockRestore();
      error.mockRestore();
    }
  });
});
