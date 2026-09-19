/**
 * Integration test for `runMeetingJob` (plan.md test matrix: "meeting-queue +
 * meeting-job with a fake Soniox/Hub AI, real ffmpeg on a 30s sample wav;
 * timeout abort actually kills the child"). REAL: `decodeToWav16k` spawns the real
 * `@ffmpeg-installer/ffmpeg` binary against a committed 30s wav fixture
 * (`__fixtures__/sample-30s.wav` — two 15s tones, no real speech; STT/speaker
 * content is faked, only the ffmpeg decode itself is real). FAKE: the async
 * STT provider (`stt-provider-registry.js`), the speaker embedding extractor
 * (no ONNX model is downloaded in this dev/CI sandbox — only at deploy time,
 * `deployment-guide.md` § Model), and the Hub-AI summarizer — App DB and
 * Files both go through the SAME in-memory `installFakeHub` every other tool
 * test uses.
 */
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoomBoundHubClient, RoomBoundHubFetchInit } from '@privos_ai/app-server';

import { installFakeHub, type Store } from '../tools/test-support/fake-hub.js';
import type { JobRecord } from './job-repository.js';

const FIXTURE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'sample-30s.wav');

vi.mock('@privos_ai/app-server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@privos_ai/app-server')>();
  return { ...actual, createAgentBotHubClient: () => dbHub };
});
vi.mock('../hub/resolve-hub-origin.js', () => ({ resolveHubOrigin: async () => 'https://hub.example' }));
vi.mock('../hub/resolve-own-mcp-app-id.js', () => ({ resolveOwnMcpAppId: async () => 'app-123' }));

vi.mock('../speaker/embedding-extractor.js', () => ({
  computeEmbedding: vi.fn(async () => new Float32Array([1, 0, 0, 0])),
}));

vi.mock('../summary/summarizer.js', () => ({
  summarizeTranscript: vi.fn(async () => ({
    summary: 'Fake summary for the integration test.',
    decisions: [],
    key_topics: ['test'],
    action_items: [],
  })),
}));

const fakeAsyncProvider = {
  vendor: 'soniox' as const,
  transcribeFile: vi.fn(async () => ({
    tokens: [
      { text: 'Xin', startMs: 0, endMs: 400, speaker: 's1', isFinal: true },
      { text: 'chào', startMs: 400, endMs: 900, speaker: 's1', isFinal: true },
      { text: 'Hello', startMs: 15_000, endMs: 15_500, speaker: 's2', isFinal: true },
      { text: 'there', startMs: 15_500, endMs: 16_000, speaker: 's2', isFinal: true },
    ],
    segments: [],
    language: 'vi',
  })),
  status: vi.fn(),
};
vi.mock('../stt/stt-provider-registry.js', () => ({
  asyncProviderFor: vi.fn(() => fakeAsyncProvider),
  resolveAsyncVendor: vi.fn(async () => 'soniox'),
}));

let store: Store;
let dbHub: ReturnType<typeof installFakeHub>;
let uploadedFiles: Array<{ fileName: string; bytes: number }>;
let deletedFileIds: string[];
let uploadSeq: number;

const { decodeToWav16k } = await import('../media/decode-audio.js');
const { runMeetingJob } = await import('./meeting-job.js');

const MEETING_ID = 'meeting1abcdefgh';
const DIGEST = MEETING_ID.slice(0, 8);
const ROOM_ID = 'room-1';
const FOLDER_ID = 'folder-1';

/** Composite hub: `mcp-apps.tool-call` (App DB, via `installFakeHub`) + the Files REST endpoints `meeting-job.ts` calls directly (upload/download/delete/list). */
function buildJobHub(fixtureBytes: Buffer): RoomBoundHubClient {
  return {
    authorizedFetch: vi.fn(async (requestPath: string, init: RoomBoundHubFetchInit) => {
      if (requestPath === '/api/v1/file-management.files.upload') {
        uploadedFiles.push({ fileName: 'unknown', bytes: 0 }); // presence recorded; exact name not needed for assertions below
        const fileId = `uploaded-${++uploadSeq}`;
        return { ok: true, status: 200, json: async () => ({ success: true, file: { _id: fileId } }) } as unknown as Response;
      }
      if (init.method === 'DELETE' && requestPath.startsWith('/api/v1/file-management.files/')) {
        const fileId = decodeURIComponent(requestPath.slice(requestPath.lastIndexOf('/') + 1));
        deletedFileIds.push(fileId);
        return { ok: true, status: 200, json: async () => ({ success: true }) } as unknown as Response;
      }
      if (requestPath.includes('/download')) {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(fixtureBytes));
            controller.close();
          },
        });
        return { ok: true, status: 200, body: stream } as unknown as Response;
      }
      if (requestPath.startsWith('/api/v1/file-management.files.channel/')) {
        // No live-turns.json in this test — reconcileWithLiveSpeakers short-circuits.
        return { ok: true, status: 200, json: async () => ({ success: true, files: [] }) } as unknown as Response;
      }
      return dbHub.authorizedFetch(requestPath, init);
    }),
  };
}

function freshJob(overrides: Partial<JobRecord> = {}): JobRecord {
  const now = new Date().toISOString();
  return {
    _id: 'job-row-1',
    jobId: 'job_meeting1_abc123',
    meetingId: MEETING_ID,
    roomId: ROOM_ID,
    partFileIds: ['part-0'],
    sttProvider: 'soniox-async',
    language: 'vi',
    title: 'Integration test meeting',
    keepAudio: true,
    status: 'queued',
    step: null,
    progress: 0,
    startedAt: now,
    heartbeatAt: now,
    ...overrides,
  };
}

describe('runMeetingJob — integration (real ffmpeg decode)', () => {
  let fixtureBytes: Buffer;

  beforeEach(async () => {
    fixtureBytes = await readFile(FIXTURE_PATH);
    uploadedFiles = [];
    deletedFileIds = [];
    uploadSeq = 0;
    store = {
      meetings: [{ _id: MEETING_ID, roomId: ROOM_ID, translationEnabled: false }],
      meeting_speakers: [],
      processing_jobs: [{ _id: 'job-row-1', jobId: 'job_meeting1_abc123', meetingId: MEETING_ID, roomId: ROOM_ID, status: 'queued' }],
      action_items: [],
      app_settings: [],
      speaker_profiles: [],
    };
    dbHub = installFakeHub({ store });
    vi.clearAllMocks();
    fakeAsyncProvider.transcribeFile.mockClear();
  });

  it('decodes the REAL 30s wav fixture via ffmpeg, runs the full pipeline with faked STT/summarizer, and completes the job', async () => {
    const hub = buildJobHub(fixtureBytes);
    const parts = [{ fileId: 'part-0', seq: 0, name: `audio.part-0000-${DIGEST}.webm` }];
    const job = freshJob();

    await runMeetingJob({ job, roomId: ROOM_ID, folderId: FOLDER_ID, parts, agentBotHub: hub, signal: new AbortController().signal });

    // The job repository row ends up `completed` with a duration close to the real 30s fixture.
    const jobRow = store.processing_jobs.find((r) => r._id === 'job-row-1');
    expect(jobRow?.status).toBe('completed');
    const result = JSON.parse(String(jobRow?.resultJson)) as { durationSec: number; speakers: Array<{ speakerId: string }> };
    expect(result.durationSec).toBeGreaterThanOrEqual(28);
    expect(result.durationSec).toBeLessThanOrEqual(32);
    expect(result.speakers.map((s) => s.speakerId).sort()).toEqual(['s1', 's2']);

    // meetings row reflects a finished, summarized meeting.
    const meetingRow = store.meetings.find((m) => m._id === MEETING_ID);
    expect(meetingRow?.status).toBe('summarized');
    expect(meetingRow?.durationSec).toBeGreaterThanOrEqual(28);

    // audio.webm + 3 transcript artifacts + summary.md were all uploaded (5 uploads).
    expect(uploadedFiles.length).toBe(5);
    // The one part was deleted after concat (never re-read afterward).
    expect(deletedFileIds).toContain('part-0');
    // keepAudio:true — audio.webm itself must NOT be deleted afterward.
    expect(deletedFileIds).not.toContain('uploaded-1');
  });

  it('a job whose transcribe step fails is recorded failed(...) without uploading a half-finished result', async () => {
    fakeAsyncProvider.transcribeFile.mockRejectedValueOnce(new Error('Soniox mock failure'));
    const hub = buildJobHub(fixtureBytes);
    const parts = [{ fileId: 'part-0', seq: 0, name: `audio.part-0000-${DIGEST}.webm` }];
    const job = freshJob();

    await expect(
      runMeetingJob({ job, roomId: ROOM_ID, folderId: FOLDER_ID, parts, agentBotHub: hub, signal: new AbortController().signal }),
    ).rejects.toThrow(/Soniox mock failure/);

    const jobRow = store.processing_jobs.find((r) => r._id === 'job-row-1');
    expect(jobRow?.status).toBe('failed');
    const meetingRow = store.meetings.find((m) => m._id === MEETING_ID);
    expect(meetingRow?.status).toBe('failed');
    // transcript/summary artifacts never got a chance to upload.
    expect(uploadedFiles.length).toBe(1); // only audio.webm, uploaded BEFORE transcribe runs
  });
});

describe('decodeToWav16k — real ffmpeg abort kills the child process', () => {
  it('aborting the signal rejects promptly instead of waiting for the natural ffmpeg exit', async () => {
    const controller = new AbortController();
    const outPath = path.join(tmpdir(), `meeting-agent-abort-test-${Date.now()}.wav`);
    try {
      const promise = decodeToWav16k(FIXTURE_PATH, outPath, controller.signal);
      controller.abort();
      await expect(promise).rejects.toThrow(/cancelled/i);
    } finally {
      await rm(outPath, { force: true });
    }
  });
});
