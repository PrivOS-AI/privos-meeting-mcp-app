import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoomBoundHubClient, RoomBoundHubFetchInit } from '@privos_ai/app-server';

import { installFakeHub, type Store } from '../tools/test-support/fake-hub.js';

vi.mock('@privos_ai/app-server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@privos_ai/app-server')>();
  return { ...actual, createAgentBotHubClient: () => baseHub };
});
vi.mock('../hub/resolve-hub-origin.js', () => ({ resolveHubOrigin: async () => 'https://hub.example' }));
vi.mock('../hub/resolve-own-mcp-app-id.js', () => ({ resolveOwnMcpAppId: async () => 'app-123' }));

let store: Store;
let baseHub: ReturnType<typeof installFakeHub>;
let deletedFileIds: string[];
let folderFiles: Record<string, Array<{ _id: string; name: string; channel_id: string; folder_id: string | null }>>;

const { purgeExpiredAudio } = await import('./audio-retention-job.js');

/** Wraps the db-only `installFakeHub` with the file-management REST paths `audio-retention-job.ts` also calls (DELETE one file, list a folder). */
function buildHub(): RoomBoundHubClient {
  return {
    authorizedFetch: vi.fn(async (path: string, init: RoomBoundHubFetchInit) => {
      if (init.method === 'DELETE' && path.startsWith('/api/v1/file-management.files/')) {
        const fileId = decodeURIComponent(path.slice(path.lastIndexOf('/') + 1));
        deletedFileIds.push(fileId);
        return { ok: true, status: 200, json: async () => ({ success: true }) } as unknown as Response;
      }
      if (path.startsWith('/api/v1/file-management.files.channel/')) {
        const folderId = new URLSearchParams(path.split('?')[1] ?? '').get('folderId') ?? '';
        return { ok: true, status: 200, json: async () => ({ success: true, files: folderFiles[folderId] ?? [] }) } as unknown as Response;
      }
      return baseHub.authorizedFetch(path, init);
    }),
  };
}

const oldIso = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

describe('purgeExpiredAudio', () => {
  beforeEach(() => {
    deletedFileIds = [];
    folderFiles = {};
    store = { meetings: [], meeting_speakers: [], app_settings: [] };
    baseHub = installFakeHub({ store });
  });

  it('deletes kept audio past autoDeleteAudioDays and stamps audioDeletedAt', async () => {
    store.app_settings = [{ _id: 's1', key: 'room:room-1:autoDeleteAudioDays', valueJson: JSON.stringify(1) }];
    store.meetings = [
      { _id: 'm1', roomId: 'room-1', status: 'summarized', keepAudio: true, endedAt: oldIso(10), audioFileId: 'audio-1' },
    ];
    const hub = buildHub();
    const result = await purgeExpiredAudio(hub, 'room-1');
    expect(result.audioDeleted).toBe(1);
    expect(deletedFileIds).toContain('audio-1');
    expect(store.meetings[0].audioDeletedAt).toBeTruthy();
  });

  it('does not touch audio when autoDeleteAudioDays is 0 (disabled)', async () => {
    store.app_settings = [{ _id: 's1', key: 'room:room-1:autoDeleteAudioDays', valueJson: JSON.stringify(0) }];
    store.meetings = [
      { _id: 'm1', roomId: 'room-1', status: 'summarized', keepAudio: true, endedAt: oldIso(500), audioFileId: 'audio-1' },
    ];
    const hub = buildHub();
    const result = await purgeExpiredAudio(hub, 'room-1');
    expect(result.audioDeleted).toBe(0);
    expect(deletedFileIds).toHaveLength(0);
  });

  it('skips a meeting whose audio was already deleted', async () => {
    store.app_settings = [{ _id: 's1', key: 'room:room-1:autoDeleteAudioDays', valueJson: JSON.stringify(1) }];
    store.meetings = [
      { _id: 'm1', roomId: 'room-1', status: 'summarized', keepAudio: true, endedAt: oldIso(10), audioFileId: 'audio-1', audioDeletedAt: oldIso(1) },
    ];
    const hub = buildHub();
    const result = await purgeExpiredAudio(hub, 'room-1');
    expect(result.audioDeleted).toBe(0);
  });

  it('deletes orphaned parts of a meeting interrupted past interruptedPartsRetentionDays', async () => {
    store.app_settings = [
      { _id: 's1', key: 'room:room-1:autoDeleteAudioDays', valueJson: JSON.stringify(0) },
      { _id: 's2', key: 'room:room-1:interruptedPartsRetentionDays', valueJson: JSON.stringify(1) },
    ];
    store.meetings = [{ _id: 'm2', roomId: 'room-1', status: 'interrupted', lastPartAt: oldIso(10), folderId: 'folder-1' }];
    folderFiles['folder-1'] = [
      { _id: 'part-1', name: 'audio.part-0000-abcd1234.webm', channel_id: 'room-1', folder_id: 'folder-1' },
      { _id: 'part-2', name: 'audio.part-0001-abcd1234.webm', channel_id: 'room-1', folder_id: 'folder-1' },
    ];
    const hub = buildHub();
    const result = await purgeExpiredAudio(hub, 'room-1');
    expect(result.orphanPartsDeleted).toBe(2);
    expect(deletedFileIds.sort()).toEqual(['part-1', 'part-2']);
  });

  it('clears pendingEmbedding on meeting_speakers rows whose meeting ended 30+ days ago', async () => {
    store.app_settings = [{ _id: 's1', key: 'room:room-1:autoDeleteAudioDays', valueJson: JSON.stringify(0) }];
    store.meetings = [{ _id: 'm3', roomId: 'room-1', status: 'summarized', endedAt: oldIso(31) }];
    store.meeting_speakers = [
      { _id: 'ms1', meeting: 'm3', pendingEmbedding: 'sealed-ciphertext', displayName: 'Người nói 1' },
      { _id: 'ms2', meeting: 'm3', pendingEmbedding: '', displayName: 'Đã xong' },
    ];
    const hub = buildHub();
    const result = await purgeExpiredAudio(hub, 'room-1');
    expect(result.pendingEmbeddingsCleared).toBe(1);
    expect(store.meeting_speakers.find((r) => r._id === 'ms1')?.pendingEmbedding).toBe('');
    expect(store.meeting_speakers.find((r) => r._id === 'ms1')?.displayName).toBe('Người nói 1');
  });

  it('does not clear pendingEmbedding for a meeting that ended less than 30 days ago', async () => {
    store.app_settings = [{ _id: 's1', key: 'room:room-1:autoDeleteAudioDays', valueJson: JSON.stringify(0) }];
    store.meetings = [{ _id: 'm4', roomId: 'room-1', status: 'summarized', endedAt: oldIso(2) }];
    store.meeting_speakers = [{ _id: 'ms3', meeting: 'm4', pendingEmbedding: 'sealed-ciphertext' }];
    const hub = buildHub();
    const result = await purgeExpiredAudio(hub, 'room-1');
    expect(result.pendingEmbeddingsCleared).toBe(0);
    expect(store.meeting_speakers[0].pendingEmbedding).toBe('sealed-ciphertext');
  });
});
