/**
 * Security (plan.md Red Team session 2 dispositions, plan.md acceptance
 * criteria): room B must not read/process/delete room A's data through a
 * bot credential that has no per-user room boundary of its own. Exercises
 * the actual TOOLS end to end (not just the `authz.ts` primitives, already
 * unit-tested in `tools/authz.test.ts`) — `meeting_process`, `meeting_status`,
 * `speaker_profile_delete`, the exact three plan.md's Red Team table names.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolCallContext } from '@privos_ai/app-server';

import { installFakeHub, type Store } from '../tools/test-support/fake-hub.js';

vi.mock('@privos_ai/app-server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@privos_ai/app-server')>();
  return { ...actual, createAgentBotHubClient: () => fakeHub };
});
vi.mock('../hub/resolve-hub-origin.js', () => ({ resolveHubOrigin: async () => 'https://hub.example' }));
vi.mock('../hub/resolve-own-mcp-app-id.js', () => ({ resolveOwnMcpAppId: async () => 'app-123' }));

let store: Store;
let fakeHub: ReturnType<typeof installFakeHub>;

const { processTool } = await import('../tools/process-tool.js');
const { statusTool } = await import('../tools/status-tool.js');
const { speakerProfileDeleteTool } = await import('../tools/speaker-profile-tools.js');

function actorContext(userId: string, roomId: string): ToolCallContext {
  return { transport: 'direct', identityState: 'verified', sessionScope: 'test', actor: { userId, roomId, claims: {}, provenance: 'user-token' } };
}

const ROOM_A = 'room-A';
const ROOM_B = 'room-B';

describe('cross-room authz — room B cannot touch room A data', () => {
  beforeEach(() => {
    store = {
      meetings: [{ _id: 'meeting-a1', roomId: ROOM_A, ownerUserId: 'user-a', status: 'recording', folderId: 'folder-a' }],
      speaker_profiles: [{ _id: 'profile-a1', displayName: 'An', displayNameNormalized: 'an', createdByUserId: 'user-a', embeddings: [], centroid: '', dim: 0, sampleCount: 0 }],
      app_settings: [],
      processing_jobs: [],
    };
    fakeHub = installFakeHub({ store });
  });

  it('meeting_process: room B actor cannot enqueue processing for room A\'s meeting', async () => {
    await expect(
      processTool.execute({ roomId: ROOM_A, meetingId: 'meeting-a1' }, actorContext('user-b', ROOM_B), { agentBotHub: fakeHub }),
    ).rejects.toThrow(/invalid request/i);
  });

  it('meeting_process: even a room-B actor claiming roomId=room-B cannot reach room A\'s meeting row', async () => {
    await expect(
      processTool.execute({ roomId: ROOM_B, meetingId: 'meeting-a1' }, actorContext('user-b', ROOM_B), { agentBotHub: fakeHub }),
    ).rejects.toThrow(/not found/i);
  });

  it('meeting_status: room B actor cannot poll room A\'s meeting status', async () => {
    await expect(
      statusTool.execute({ roomId: ROOM_A, meetingId: 'meeting-a1' }, actorContext('user-b', ROOM_B), { agentBotHub: fakeHub }),
    ).rejects.toThrow(/invalid request/i);
  });

  it('speaker_profile_delete: a different (non-admin, non-creator) user cannot delete room A\'s speaker profile', async () => {
    await expect(
      speakerProfileDeleteTool.execute({ profileId: 'profile-a1' }, actorContext('user-b', ROOM_B), { agentBotHub: fakeHub }),
    ).rejects.toThrow(/workspace admin/i);
    expect(store.speaker_profiles).toHaveLength(1);
  });
});
