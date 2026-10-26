/**
 * `meeting_process` decides whether the original audio is kept from the
 * room's `keepOriginalAudio` setting, on the server — never from the
 * `keepAudio` field the iframe can write on the meeting row.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolCallContext } from '@privos_ai/app-server';

import { installFakeHub, type Store } from './test-support/fake-hub.js';

vi.mock('@privos_ai/app-server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@privos_ai/app-server')>();
  return { ...actual, createAgentBotHubClient: () => fakeHub };
});
vi.mock('../hub/resolve-hub-origin.js', () => ({ resolveHubOrigin: async () => 'https://hub.example' }));
vi.mock('../hub/resolve-own-mcp-app-id.js', () => ({ resolveOwnMcpAppId: async () => 'app-123' }));
vi.mock('../media/hub-file-download.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../media/hub-file-download.js')>()),
  listRoomFolderFiles: async () => [{ _id: 'part-file-1', name: 'audio.part-0001-meeting1.webm', channel_id: ROOM, folder_id: 'folder-1' }],
}));
vi.mock('./authz.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./authz.js')>()),
  assertFileInRoom: async () => undefined,
}));
// The job itself is not under test: never run it.
vi.mock('../jobs/meeting-queue.js', () => ({ JOB_TIMEOUT_MS: 1000, meetingQueue: { enqueue: vi.fn(async () => undefined) } }));

const ROOM = 'room-1';
let store: Store;
let fakeHub: ReturnType<typeof installFakeHub>;

const { processTool } = await import('./process-tool.js');

function ownerContext(): ToolCallContext {
  return { transport: 'direct', identityState: 'verified', sessionScope: 'test', actor: { userId: 'owner-1', roomId: ROOM, claims: {}, provenance: 'user-token' } };
}

async function runProcess() {
  await processTool.execute({ roomId: ROOM, meetingId: 'meeting-1' }, ownerContext(), { agentBotHub: fakeHub });
  return { meeting: store.meetings[0], job: store.processing_jobs[0] };
}

describe('meeting_process keepAudio', () => {
  beforeEach(() => {
    store = {
      // The iframe wrote keepAudio:true; the server must not trust it.
      meetings: [{ _id: 'meeting-1', roomId: ROOM, ownerUserId: 'owner-1', status: 'uploading', folderId: 'folder-1', keepAudio: true }],
      app_settings: [],
      processing_jobs: [],
    };
    fakeHub = installFakeHub({ store });
  });

  it('defaults to not keeping the audio when the room never set keepOriginalAudio', async () => {
    const { meeting, job } = await runProcess();
    expect(job.keepAudio).toBe(false);
    expect(meeting.keepAudio).toBe(false);
  });

  it('keeps the audio when the room enabled keepOriginalAudio', async () => {
    store.app_settings = [{ _id: 's1', key: `room:${ROOM}:keepOriginalAudio`, valueJson: 'true' }];
    const { meeting, job } = await runProcess();
    expect(job.keepAudio).toBe(true);
    expect(meeting.keepAudio).toBe(true);
  });

  it('reads the setting of the meeting\'s own room only', async () => {
    store.app_settings = [{ _id: 's1', key: 'room:other-room:keepOriginalAudio', valueJson: 'true' }];
    const { job } = await runProcess();
    expect(job.keepAudio).toBe(false);
  });
});
