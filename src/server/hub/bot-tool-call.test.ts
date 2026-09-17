import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  lastCall: undefined as undefined | { path: string; init: Record<string, unknown> },
  response: {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ success: true, content: [{ type: 'text', text: JSON.stringify({ hello: 'world' }) }] }),
  } as { ok: boolean; status: number; text: () => Promise<string> },
}));

vi.mock('@privos_ai/app-server', () => ({
  createAgentBotHubClient: () => ({
    authorizedFetch: async (path: string, init: Record<string, unknown>) => {
      hoisted.lastCall = { path, init };
      return hoisted.response;
    },
  }),
}));

vi.mock('./resolve-hub-origin.js', () => ({ resolveHubOrigin: async () => 'https://hub.example' }));
vi.mock('./resolve-own-mcp-app-id.js', () => ({ resolveOwnMcpAppId: async () => 'app-123' }));

const { callAppPlatformTool } = await import('./bot-tool-call.js');

describe('callAppPlatformTool', () => {
  beforeEach(() => {
    hoisted.lastCall = undefined;
    hoisted.response = {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ success: true, content: [{ type: 'text', text: JSON.stringify({ hello: 'world' }) }] }),
    };
  });

  it('sends mcpAppId + toolName + arguments and includes roomId only when given', async () => {
    await callAppPlatformTool('mcpapp.db.query', { collection: 'meetings' }, 'db:read', 'room-9');
    const body = JSON.parse(String(hoisted.lastCall?.init.body));
    expect(body).toEqual({ mcpAppId: 'app-123', toolName: 'mcpapp.db.query', arguments: { collection: 'meetings' }, roomId: 'room-9' });
    expect(hoisted.lastCall?.init.requiredScope).toBe('db:read');
  });

  it('omits roomId for a room-less (global) call', async () => {
    await callAppPlatformTool('mcpapp.db.getSchema', { collection: 'app_settings' }, 'db:schema:read');
    const body = JSON.parse(String(hoisted.lastCall?.init.body));
    expect('roomId' in body).toBe(false);
  });

  it('unwraps content[0].text as JSON', async () => {
    const result = await callAppPlatformTool('mcpapp.db.query', {}, 'db:read');
    expect(result).toEqual({ hello: 'world' });
  });

  it('throws with the Hub error message on a failed result', async () => {
    hoisted.response = { ok: false, status: 403, text: async () => JSON.stringify({ success: false, error: 'forbidden' }) };
    await expect(callAppPlatformTool('mcpapp.db.query', {}, 'db:read')).rejects.toThrow(/forbidden/);
  });
});
