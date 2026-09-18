import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolCallContext } from '@privos_ai/app-server';

import type { ToolRuntime } from './registry.js';
import { installFakeHub, type Store } from './test-support/fake-hub.js';

vi.mock('@privos_ai/app-server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@privos_ai/app-server')>();
  return { ...actual, createAgentBotHubClient: () => fakeHub };
});
vi.mock('../hub/resolve-hub-origin.js', () => ({ resolveHubOrigin: async () => 'https://hub.example' }));
vi.mock('../hub/resolve-own-mcp-app-id.js', () => ({ resolveOwnMcpAppId: async () => 'app-123' }));

let store: Store;
let fakeHub: ReturnType<typeof installFakeHub>;
let generateCalls: Record<string, unknown>[];

function context(userId: string): ToolCallContext {
  return {
    transport: 'direct',
    identityState: 'verified',
    sessionScope: 'test',
    actor: { userId, roomId: 'room-1', claims: {}, provenance: 'user-token' },
  };
}

const { resetRateLimits } = await import('./rate-limiter.js');
const { translateTool } = await import('./translate-tool.js');

describe('meeting_translate', () => {
  beforeEach(() => {
    resetRateLimits();
    generateCalls = [];
    store = { meetings: [{ _id: 'meeting-1', roomId: 'room-1', ownerUserId: 'user-1', status: 'recording' }] };
    fakeHub = installFakeHub({
      store,
      handlers: {
        '/api/v1/agents.sandbox.generate': (body) => {
          generateCalls.push(body);
          const prompt = String(body.prompt);
          const start = prompt.lastIndexOf('<transcript>') + '<transcript>'.length;
          const end = prompt.lastIndexOf('</transcript>');
          const segments = JSON.parse(prompt.slice(start, end)) as { id: string; text: string }[];
          const translations = segments.map((s) => ({ id: s.id, text: `[EN] ${s.text}` }));
          return { text: JSON.stringify(translations), source: 'room' };
        },
      },
    });
  });

  function runtime(): ToolRuntime {
    return { agentBotHub: fakeHub };
  }

  it('translates a batch of final lines via Hub AI', async () => {
    const result = (await translateTool.execute(
      {
        roomId: 'room-1',
        meetingId: 'meeting-1',
        target: 'en',
        segments: [{ id: 'l1', text: 'xin chào', lang: 'vi' }],
      },
      context('user-1'),
      runtime(),
    )) as { translations: { id: string; text: string }[] };

    expect(result.translations).toEqual([{ id: 'l1', text: '[EN] xin chào' }]);
    expect(generateCalls).toHaveLength(1);
  });

  it('skips segments already in the target language without calling Hub AI', async () => {
    const result = (await translateTool.execute(
      {
        roomId: 'room-1',
        meetingId: 'meeting-1',
        target: 'en',
        segments: [{ id: 'l1', text: 'hello', lang: 'en' }],
      },
      context('user-1'),
      runtime(),
    )) as { translations: { id: string; text: string }[] };

    expect(result.translations).toEqual([{ id: 'l1', text: 'hello' }]);
    expect(generateCalls).toHaveLength(0);
  });

  it('rejects a caller outside the meeting room', async () => {
    await expect(
      translateTool.execute(
        { roomId: 'room-other', meetingId: 'meeting-1', target: 'en', segments: [{ id: 'l1', text: 'x' }] },
        context('user-1'),
        runtime(),
      ),
    ).rejects.toThrow(/không hợp lệ/);
  });

  it('rate-limits repeated calls for the same meeting', async () => {
    for (let i = 0; i < 30; i++) {
      await translateTool.execute(
        { roomId: 'room-1', meetingId: 'meeting-1', target: 'en', segments: [{ id: `l${i}`, text: 'a' }] },
        context('user-1'),
        runtime(),
      );
    }
    await expect(
      translateTool.execute(
        { roomId: 'room-1', meetingId: 'meeting-1', target: 'en', segments: [{ id: 'l99', text: 'a' }] },
        context('user-1'),
        runtime(),
      ),
    ).rejects.toThrow(/giới hạn tần suất/);
  });
});
