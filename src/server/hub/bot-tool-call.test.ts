import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  lastCall: undefined as undefined | { path: string; init: Record<string, unknown> },
  calls: [] as Array<{ toolName: string }>,
  /** When set, answers `mcpapp.context.get` (the membership probe) instead of `response`. */
  probeResponse: undefined as undefined | { ok: boolean; status: number; text: () => Promise<string> },
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
      const toolName = String(JSON.parse(String(init.body)).toolName);
      hoisted.calls.push({ toolName });
      return toolName === 'mcpapp.context.get' && hoisted.probeResponse ? hoisted.probeResponse : hoisted.response;
    },
  }),
}));

vi.mock('./resolve-hub-origin.js', () => ({ resolveHubOrigin: async () => 'https://hub.example' }));
vi.mock('./resolve-own-mcp-app-id.js', () => ({ resolveOwnMcpAppId: async () => 'app-123' }));

const { callAppPlatformTool } = await import('./bot-tool-call.js');

describe('callAppPlatformTool', () => {
  beforeEach(() => {
    hoisted.lastCall = undefined;
    hoisted.calls = [];
    hoisted.probeResponse = undefined;
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

  describe('scope refusal: bot outside the room vs a real grant gap', () => {
    const refused = (error: string) => ({ ok: false, status: 403, text: async () => JSON.stringify({ success: false, error }) });
    const scopeRefusal = refused('Insufficient scope: requires "db:read"');

    it.each(['Not allowed', 'MCP installation is not active for this caller'])('maps a probe answering "%s" to ASSISTANT_NOT_IN_ROOM with the bot slug', async (probeError) => {
      hoisted.response = scopeRefusal;
      hoisted.probeResponse = refused(probeError);
      await expect(callAppPlatformTool('mcpapp.db.query', {}, 'db:read', 'room-9')).rejects.toMatchObject({
        code: 'ASSISTANT_NOT_IN_ROOM',
        details: { scope: 'db:read', botSlug: 'meeting-agent-privos' },
      });
    });

    it('maps a scope refusal with a healthy probe to PERMISSION_NOT_GRANTED', async () => {
      hoisted.response = scopeRefusal;
      hoisted.probeResponse = { ok: true, status: 200, text: async () => JSON.stringify({ success: true, content: [{ type: 'text', text: '{}' }] }) };
      await expect(callAppPlatformTool('mcpapp.db.query', {}, 'db:read', 'room-9')).rejects.toMatchObject({ code: 'PERMISSION_NOT_GRANTED', details: { scope: 'db:read' } });
    });

    it('never probes on a failure that is not a scope refusal', async () => {
      hoisted.response = refused('Collection not registered');
      await expect(callAppPlatformTool('mcpapp.db.query', {}, 'db:read', 'room-9')).rejects.toMatchObject({ code: 'HUB_ERROR' });
      expect(hoisted.calls.map((c) => c.toolName)).toEqual(['mcpapp.db.query']);
    });
  });

  it('throws with the Hub error message on a failed result', async () => {
    hoisted.response = { ok: false, status: 403, text: async () => JSON.stringify({ success: false, error: 'forbidden' }) };
    await expect(callAppPlatformTool('mcpapp.db.query', {}, 'db:read')).rejects.toThrow(/forbidden/);
  });
});
