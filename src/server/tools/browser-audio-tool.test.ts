import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolCallContext } from '@privos_ai/app-server';

import { installFakeHub, type Store } from './test-support/fake-hub.js';

vi.mock('@privos_ai/app-server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@privos_ai/app-server')>();
  return { ...actual, createAgentBotHubClient: () => fakeHub };
});
vi.mock('../hub/resolve-hub-origin.js', () => ({ resolveHubOrigin: async () => 'https://hub.example' }));
vi.mock('../hub/resolve-own-mcp-app-id.js', () => ({ resolveOwnMcpAppId: async () => 'app-123' }));
// The listener itself is covered by browser-audio-listener.test.ts; here only who may drive it.
const started: Array<{ roomId: string; folderId: string; meetingId: string }> = [];
let running = false;
vi.mock('../browser-audio/browser-audio-listener.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../browser-audio/browser-audio-listener.js')>();
  const listener = { status: () => ({ state: 'listening', heardSec: 3, partsUploaded: 0 }), captionsSince: () => ({ captions: [], cursor: 0, draft: null, degraded: false }) };
  return {
    ...actual,
    startBrowserAudio: (ctx: { roomId: string; folderId: string; meetingId: string }) => {
      started.push({ roomId: ctx.roomId, folderId: ctx.folderId, meetingId: ctx.meetingId });
      running = true;
      return listener;
    },
    browserAudioFor: () => (running ? listener : undefined),
    stopBrowserAudio: async () => {
      const was = running;
      running = false;
      return was ? { state: 'stopped', heardSec: 3, partsUploaded: 1 } : undefined;
    },
  };
});

let store: Store;
let fakeHub: ReturnType<typeof installFakeHub>;

const { browserAudioTool, resetBrowserAudioOwnerChecksForTests } = await import('./browser-audio-tool.js');
const { resetRateLimits } = await import('./rate-limiter.js');
const { env } = await import('../env.js');

function ctx(userId = 'owner-1'): ToolCallContext {
  return { transport: 'direct', identityState: 'verified', sessionScope: 'test', actor: { userId, roomId: 'room-1', claims: {}, provenance: 'user-token' } };
}
const args = (action: string) => ({ roomId: 'room-1', meetingId: 'meeting-1', action });
const runtime = { agentBotHub: {} } as never;

describe('meeting_browser_audio', () => {
  beforeEach(() => {
    resetRateLimits();
    resetBrowserAudioOwnerChecksForTests();
    started.length = 0;
    running = false;
    env.remoteBrowserAudioUrl = 'http://remote-browser:8787';
    env.remoteBrowserAudioTapKey = 'k'.repeat(40);
    store = { meetings: [{ _id: 'meeting-1', roomId: 'room-1', ownerUserId: 'owner-1', status: 'recording', folderId: 'folder-1' }] };
    fakeHub = installFakeHub({ store });
  });

  it("starts listening to the caller's own room, polls, and stops", async () => {
    await expect(browserAudioTool.execute(args('start'), ctx(), runtime)).resolves.toMatchObject({ state: 'listening' });
    expect(started).toEqual([{ roomId: 'room-1', folderId: 'folder-1', meetingId: 'meeting-1' }]);
    await expect(browserAudioTool.execute(args('poll'), ctx(), runtime)).resolves.toMatchObject({ state: 'listening', cursor: 0 });
    await expect(browserAudioTool.execute(args('stop'), ctx(), runtime)).resolves.toMatchObject({ state: 'stopped', partsUploaded: 1 });
  });

  it('is unavailable when the deployment does not link Remote Browser', async () => {
    env.remoteBrowserAudioTapKey = undefined;
    await expect(browserAudioTool.execute(args('start'), ctx(), runtime)).rejects.toMatchObject({ code: 'PROVIDER_NOT_CONFIGURED' });
  });

  it('refuses anyone but the meeting owner, and a meeting that is not recording', async () => {
    await expect(browserAudioTool.execute(args('start'), ctx('someone-else'), runtime)).rejects.toMatchObject({ code: 'NOT_MEETING_OWNER' });
    await expect(browserAudioTool.execute(args('poll'), ctx('someone-else'), runtime)).rejects.toMatchObject({ code: 'NOT_MEETING_OWNER' });
    store.meetings[0].status = 'summarized';
    await expect(browserAudioTool.execute(args('start'), ctx(), runtime)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(started).toEqual([]);
  });

  it('refuses a room other than the actor’s', async () => {
    await expect(browserAudioTool.execute({ ...args('start'), roomId: 'room-2' }, ctx(), runtime)).rejects.toMatchObject({ code: 'ROOM_MISMATCH' });
  });

  it('says when a meeting is not listening to the Room browser', async () => {
    await expect(browserAudioTool.execute(args('poll'), ctx(), runtime)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(browserAudioTool.execute({ ...args('start'), action: 'listen' }, ctx(), runtime)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});
