import { beforeEach, describe, expect, it, vi } from 'vitest';

import { installFakeHub, type Store } from '../tools/test-support/fake-hub.js';

vi.mock('@privos_ai/app-server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@privos_ai/app-server')>();
  return { ...actual, createAgentBotHubClient: () => fakeHub };
});
vi.mock('../hub/resolve-hub-origin.js', () => ({ resolveHubOrigin: async () => 'https://hub.example' }));
vi.mock('../hub/resolve-own-mcp-app-id.js', () => ({ resolveOwnMcpAppId: async () => 'app-123' }));

let store: Store;
let fakeHub: ReturnType<typeof installFakeHub>;

const { AppDbBotClient } = await import('../hub/app-db-bot-client.js');
const { JobRepository } = await import('./job-repository.js');

function repo() {
  return new JobRepository(new AppDbBotClient('room-1'));
}

const claimInput = {
  meetingId: 'm1',
  roomId: 'room-1',
  partFileIds: ['f1'],
  sttProvider: 'soniox-async' as const,
  language: 'vi',
  title: 'Meeting',
  keepAudio: true,
};

describe('JobRepository', () => {
  beforeEach(() => {
    store = { processing_jobs: [] };
    fakeHub = installFakeHub({ store });
  });

  it('claim() creates one row, and a second claim() for the same meeting reuses it — not a duplicate', async () => {
    const r = repo();
    const first = await r.claim(claimInput);
    expect(store.processing_jobs).toHaveLength(1);

    const second = await r.claim({ ...claimInput, partFileIds: ['f1', 'f2'] });
    expect(second.jobId).toBe(first.jobId);
    expect(second._id).toBe(first._id);
    expect(store.processing_jobs).toHaveLength(1);
    expect(second.partFileIds).toEqual(['f1', 'f2']);
  });

  it('sweepStale re-queues a dead `processing` job once, then fails it; a live one is untouched', async () => {
    const r = repo();
    const stuck = await r.claim(claimInput);
    await r.markProcessing(stuck._id);
    store.processing_jobs = store.processing_jobs.map((row) =>
      row._id === stuck._id ? { ...row, heartbeatAt: new Date(Date.now() - 20 * 60_000).toISOString() } : row,
    );

    const fresh = await r.claim({ ...claimInput, meetingId: 'm2' });
    await r.markProcessing(fresh._id);

    const first = await r.sweepStale(10 * 60_000);
    expect(first.requeued.map((j) => j.meetingId)).toEqual(['m1']);
    expect(first.failed).toEqual([]);
    expect((await r.findByMeeting('m1'))?.status).toBe('queued');
    expect((await r.findByMeeting('m2'))?.status).toBe('processing');

    // Interrupted again after its automatic retry: given up on.
    await r.markProcessing(stuck._id);
    store.processing_jobs = store.processing_jobs.map((row) =>
      row._id === stuck._id ? { ...row, heartbeatAt: new Date(Date.now() - 20 * 60_000).toISOString() } : row,
    );
    const second = await r.sweepStale(10 * 60_000);
    expect(second.requeued).toEqual([]);
    expect(second.failed.map((j) => j.meetingId)).toEqual(['m1']);
    expect((await r.findByMeeting('m1'))?.status).toBe('failed');

    // An explicit retry (claim) earns a fresh automatic retry.
    expect((await r.claim(claimInput)).autoRetries).toBe(0);
  });

  it('finish() writes the result and marks the job completed', async () => {
    const r = repo();
    const job = await r.claim({ ...claimInput, meetingId: 'm3' });
    await r.finish(job._id, {
      durationSec: 10,
      languageCode: 'vi',
      sttProvider: 'soniox-async',
      speakers: [],
      fileIds: { transcriptJson: 'a', transcriptMd: 'b', srt: 'c' },
    });
    const found = await r.findByMeeting('m3');
    expect(found?.status).toBe('completed');
    expect(found?.result?.fileIds.transcriptJson).toBe('a');
    expect(found?.progress).toBe(1);
  });

  it('fail() records the error message and marks the job failed', async () => {
    const r = repo();
    const job = await r.claim({ ...claimInput, meetingId: 'm4' });
    await r.fail(job._id, 'boom');
    const found = await r.findByMeeting('m4');
    expect(found?.status).toBe('failed');
    expect(found?.error).toBe('boom');
  });

  it('listQueued only returns jobs still in `queued`', async () => {
    const r = repo();
    const queued = await r.claim({ ...claimInput, meetingId: 'm5' });
    const running = await r.claim({ ...claimInput, meetingId: 'm6' });
    await r.markProcessing(running._id);

    const list = await r.listQueued();
    expect(list.map((j) => j._id)).toEqual([queued._id]);
  });
});
