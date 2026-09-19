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
let sentMessages: Record<string, unknown>[];

function context(userId: string): ToolCallContext {
  return { transport: 'direct', identityState: 'verified', sessionScope: 'test', actor: { userId, roomId: 'room-1', claims: {}, provenance: 'user-token' } };
}

function runtime(): ToolRuntime {
  return { agentBotHub: fakeHub };
}

const { sendToChatTool } = await import('./send-to-chat-tool.js');

describe('meeting_send_to_chat', () => {
  beforeEach(() => {
    sentMessages = [];
    store = {
      meetings: [{ _id: 'meeting-1', roomId: 'room-1', ownerUserId: 'user-1', title: 'Weekly meeting', summaryText: 'Meeting summary.', summaryFileId: 'file-1' }],
    };
    fakeHub = installFakeHub({
      store,
      handlers: {
        'mcpapp.bot.sendMessage': (args) => {
          sentMessages.push(args);
          return { ok: true };
        },
      },
    });
  });

  it('builds the message server-side from the stored summary and records sentToChatAt', async () => {
    const result = (await sendToChatTool.execute({ roomId: 'room-1', meetingId: 'meeting-1' }, context('user-1'), runtime())) as {
      sent: boolean;
      sentAt: string;
    };
    expect(result.sent).toBe(true);
    expect(sentMessages).toHaveLength(1);
    expect(String(sentMessages[0].text)).toContain('Meeting summary.');
    expect(String(sentMessages[0].text)).toContain('Weekly meeting');

    const rows = store.meetings.filter((m) => m._id === 'meeting-1');
    expect(rows[0].sentToChatAt).toBe(result.sentAt);
  });

  it('rejects when there is no saved summary yet', async () => {
    store.meetings[0].summaryText = undefined;
    await expect(sendToChatTool.execute({ roomId: 'room-1', meetingId: 'meeting-1' }, context('user-1'), runtime())).rejects.toThrow(/summary/);
  });

  it('rejects a caller who does not own the meeting', async () => {
    await expect(sendToChatTool.execute({ roomId: 'room-1', meetingId: 'meeting-1' }, context('someone-else'), runtime())).rejects.toThrow(/meeting owner/);
  });

  it('surfaces the Hub error instead of silently failing when the bot tool call fails', async () => {
    fakeHub = installFakeHub({
      store,
      handlers: {
        'mcpapp.bot.sendMessage': () => {
          throw new Error('bot not in room');
        },
      },
    });
    await expect(sendToChatTool.execute({ roomId: 'room-1', meetingId: 'meeting-1' }, context('user-1'), runtime())).rejects.toThrow();
  });
});
