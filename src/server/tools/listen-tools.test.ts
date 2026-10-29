import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolCallContext } from '@privos_ai/app-server';

import { installFakeHub, type Store } from './test-support/fake-hub.js';

vi.mock('@privos_ai/app-server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@privos_ai/app-server')>();
  return { ...actual, createAgentBotHubClient: () => fakeHub };
});
vi.mock('../hub/resolve-hub-origin.js', () => ({ resolveHubOrigin: async () => 'https://hub.example' }));
vi.mock('../hub/resolve-own-mcp-app-id.js', () => ({ resolveOwnMcpAppId: async () => 'app-123' }));
const folders: string[] = [];
vi.mock('../files/hub-folders.js', () => ({
  ensureRoomFolderPath: async (_hub: unknown, _roomId: string, path: string) => {
    folders.push(path);
    return `folder-${folders.length}`;
  },
}));
const listening = new Map<string, { folderId: string }>();
vi.mock('../browser-audio/browser-audio-listener.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../browser-audio/browser-audio-listener.js')>();
  const listenerFor = (meetingId: string) => ({
    status: () => ({ state: 'listening', heardSec: 12, partsUploaded: 0 }),
    captionsSince: () => ({ captions: [1, 2, 3, 4, 5, 6].map((n) => ({ index: n, id: `c${n}`, text: `line ${n}`, atSec: n * 2, endSec: n * 2 + 1, lang: 'vi' })), cursor: 6, draft: null, degraded: false }),
    meetingId,
  });
  return {
    ...actual,
    startBrowserAudio: (ctx: { meetingId: string; folderId: string }) => {
      listening.set(ctx.meetingId, { folderId: ctx.folderId });
      return listenerFor(ctx.meetingId);
    },
    browserAudioFor: (meetingId: string) => (listening.has(meetingId) ? listenerFor(meetingId) : undefined),
    stopBrowserAudio: async (meetingId: string) => {
      const was = listening.delete(meetingId);
      return was ? { state: 'stopped', heardSec: 125.4, partsUploaded: 3 } : undefined;
    },
  };
});
const processed: string[] = [];
vi.mock('./process-tool.js', () => ({
  processTool: { execute: async (args: { meetingId: string }) => (processed.push(args.meetingId), { jobId: 'job-1', status: 'queued' }) },
}));

let store: Store;
let fakeHub: ReturnType<typeof installFakeHub>;

const { listenStartTool, listenStatusTool, listenStopTool } = await import('./listen-tools.js');
const { resetRateLimits } = await import('./rate-limiter.js');
const { env } = await import('../env.js');

function ctx(userId = 'owner-1'): ToolCallContext {
  return { transport: 'direct', identityState: 'verified', sessionScope: 'test', actor: { userId, roomId: 'room-1', claims: {}, provenance: 'user-token' } };
}
const runtime = { agentBotHub: {} } as never;
const start = (over: Record<string, unknown> = {}, who = 'owner-1') => listenStartTool.execute({ roomId: 'room-1', participantsInformed: true, title: 'Weekly sync', ...over }, ctx(who), runtime);

describe('meeting_listen_* (the Room agent records a call)', () => {
  beforeEach(() => {
    resetRateLimits();
    folders.length = 0;
    listening.clear();
    processed.length = 0;
    env.remoteBrowserAudioUrl = 'http://remote-browser:8787';
    env.remoteBrowserAudioTapKey = 'k'.repeat(40);
    store = { meetings: [] };
    fakeHub = installFakeHub({ store });
  });

  it("creates the caller's meeting with its Files folder and starts listening", async () => {
    const result = (await start({ language: 'en' })) as { meetingId: string; continued: boolean; state: string };
    expect(result).toMatchObject({ continued: false, state: 'listening' });
    const row = store.meetings.find((m) => m._id === result.meetingId)!;
    expect(row).toMatchObject({ roomId: 'room-1', ownerUserId: 'owner-1', status: 'recording', captureSource: 'browser', language: 'en', title: 'Weekly sync', folderId: 'folder-1' });
    expect(row.voiceprintNoticeAt).toBeTruthy();
    expect(folders[0]).toMatch(/^Meetings\/\d{4}-\d{2}-\d{2}-weekly-sync-/);
    expect(listening.get(result.meetingId)).toEqual({ folderId: 'folder-1' });
  });

  it('refuses to record until the user confirmed the participants were told', async () => {
    await expect(start({ participantsInformed: false })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(start({ participantsInformed: 'yes' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(store.meetings).toEqual([]);
  });

  it('only works in the caller’s own room, and only when Remote Browser is linked', async () => {
    await expect(listenStartTool.execute({ roomId: 'room-2', participantsInformed: true }, ctx(), runtime)).rejects.toMatchObject({ code: 'ROOM_MISMATCH' });
    env.remoteBrowserAudioTapKey = undefined;
    await expect(start()).rejects.toMatchObject({ code: 'PROVIDER_NOT_CONFIGURED' });
  });

  it('a repeated start continues the running recording instead of making a second one', async () => {
    const first = (await start()) as { meetingId: string };
    const again = (await start()) as { meetingId: string; continued: boolean };
    expect(again).toMatchObject({ meetingId: first.meetingId, continued: true });
    expect(store.meetings).toHaveLength(1);
  });

  it('status gives the latest captions while recording, and only to the owner', async () => {
    const { meetingId } = (await start()) as { meetingId: string };
    const status = (await listenStatusTool.execute({ roomId: 'room-1', meetingId }, ctx(), runtime)) as { recentCaptions: Array<{ text: string }> };
    expect(status).toMatchObject({ status: 'recording', state: 'listening' });
    expect(status.recentCaptions.map((c) => c.text)).toEqual(['line 2', 'line 3', 'line 4', 'line 5', 'line 6']);
    await expect(listenStatusTool.execute({ roomId: 'room-1', meetingId }, ctx('someone-else'), runtime)).rejects.toMatchObject({ code: 'NOT_MEETING_OWNER' });
  });

  it('stop saves the last audio, closes the meeting and starts processing; then status gives the summary', async () => {
    const { meetingId } = (await start()) as { meetingId: string };
    await expect(listenStopTool.execute({ roomId: 'room-1', meetingId }, ctx('someone-else'), runtime)).rejects.toMatchObject({ code: 'NOT_MEETING_OWNER' });
    const stopped = await listenStopTool.execute({ roomId: 'room-1', meetingId }, ctx(), runtime);
    expect(stopped).toMatchObject({ meetingId, heardSec: 125.4, jobId: 'job-1', processing: 'queued' });
    const row = store.meetings.find((m) => m._id === meetingId)!;
    expect(row).toMatchObject({ status: 'uploading', durationSec: 125 });
    expect(processed).toEqual([meetingId]);

    Object.assign(row, { status: 'summarized', summaryText: 'We agreed to ship on Friday.', keyTopics: ['release'] });
    await expect(listenStatusTool.execute({ roomId: 'room-1', meetingId }, ctx(), runtime)).resolves.toMatchObject({ status: 'summarized', summary: 'We agreed to ship on Friday.', keyTopics: ['release'] });
  });
});
