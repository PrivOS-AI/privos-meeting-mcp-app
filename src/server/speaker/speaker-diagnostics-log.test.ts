import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { RoomBoundHubClient } from '@privos_ai/app-server';

// Lets one test simulate an unwritable diagnostics directory without touching
// every other `node:fs/promises` call this file makes for real (readFile,
// writeFile, utimes, ...) — only `mkdir` is wrapped, everything else is the
// real implementation.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, mkdir: vi.fn(actual.mkdir) };
});

// Isolates every write this test file makes under a throwaway temp dir —
// `dataDir` (paths.ts) reads `MEETING_DATA_DIR` ONCE at module-eval time, so
// this MUST run before the dynamic import below.
const tempDataDir = mkdtempSync(path.join(tmpdir(), 'meeting-agent-diagnostics-'));
process.env.MEETING_DATA_DIR = tempDataDir;
afterAll(() => {
  delete process.env.MEETING_DATA_DIR;
  rmSync(tempDataDir, { recursive: true, force: true });
});

const { append, flush, logEvent, uploadRoomCopy } = await import('./speaker-diagnostics-log.js');
import type { DiagnosticEvent, DiagnosticsBufferHost } from './speaker-diagnostics-log.js';

function diagnosticsFile(meetingId: string): string {
  return path.join(tempDataDir, 'diagnostics', `${meetingId}.jsonl`);
}

async function readJsonLines(filePath: string): Promise<Record<string, unknown>[]> {
  const raw = await readFile(filePath, 'utf8').catch(() => '');
  return raw
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** A minimal `DiagnosticsBufferHost` — the real buffer lives on `MeetingSessionRegistry`; this stands in for it. */
function fakeHost(meetingId: string): DiagnosticsBufferHost {
  let buffer: Record<string, unknown>[] = [];
  return {
    meetingId,
    pushDiagnosticEvent: (event) => buffer.push(event),
    drainDiagnosticEvents: () => {
      const out = buffer;
      buffer = [];
      return out;
    },
  };
}

function chunkEvent(overrides: Partial<DiagnosticEvent> = {}): DiagnosticEvent {
  return {
    t: Date.now(),
    meetingId: 'm-chunk',
    type: 'chunk',
    seq: 0,
    spans: [],
    clientDurationMs: 60_000,
    decodedDurationSec: 60,
    uploadLagMs: 0,
    captureDriftMs: 0,
    overlapSec: 8,
    deferredCount: 0,
    skipped: { window: 0, silence: 0, short: 0 },
    ok: true,
    ...overrides,
  } as DiagnosticEvent;
}

describe('speaker-diagnostics-log', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('append buffers onto the host, flush drains it to the node-local JSONL file', async () => {
    const host = fakeHost('m-flush');
    append(host, chunkEvent({ meetingId: 'm-flush', seq: 3 }));
    append(host, { t: Date.now(), meetingId: 'm-flush', type: 'gap', fromSeq: 1, toSeq: 3 });

    await flush(host);

    const lines = await readJsonLines(diagnosticsFile('m-flush'));
    expect(lines).toHaveLength(2);
    expect(lines[0].type).toBe('chunk');
    expect(lines[0].seq).toBe(3);
    expect(lines[1].type).toBe('gap');
    // Draining twice (a second flush with nothing buffered) must not duplicate or error.
    await flush(host);
    expect(await readJsonLines(diagnosticsFile('m-flush'))).toHaveLength(2);
  });

  it('the field allowlist drops any key not declared for that event type, even a forged one', async () => {
    const host = fakeHost('m-allowlist');
    const forged = {
      ...chunkEvent({ meetingId: 'm-allowlist' }),
      vector: [0.1, 0.2, 0.3],
      transcriptText: 'this must never be logged',
      profileId: 'should-not-appear-on-a-chunk-event',
    };
    append(host, forged);
    await flush(host);

    const [line] = await readJsonLines(diagnosticsFile('m-allowlist'));
    expect(line.vector).toBeUndefined();
    expect(line.transcriptText).toBeUndefined();
    expect(line.profileId).toBeUndefined();
    expect(line.seq).toBe(0); // declared fields still pass through
  });

  it('logEvent writes a single event directly, for call sites with no live registry', async () => {
    await logEvent('m-direct', {
      t: Date.now(),
      meetingId: 'm-direct',
      type: 'enrol',
      profile: 'profile-real-id',
      source: 'auto-post',
      coherence: 0.95,
      durationSec: 12,
      vectorCountAfter: 3,
    });

    const [line] = await readJsonLines(diagnosticsFile('m-direct'));
    expect(line.type).toBe('enrol');
    expect(line.profile).toBe('profile-real-id');
  });

  it('an unwritable diagnostics directory never throws out of flush or logEvent', async () => {
    const mockMkdir = mkdir as unknown as ReturnType<typeof vi.fn>;
    mockMkdir.mockRejectedValueOnce(new Error('EACCES: permission denied'));

    const host = fakeHost('m-unwritable');
    append(host, chunkEvent({ meetingId: 'm-unwritable' }));
    await expect(flush(host)).resolves.toBeUndefined();

    mockMkdir.mockRejectedValueOnce(new Error('EACCES: permission denied'));
    await expect(
      logEvent('m-unwritable', { t: Date.now(), meetingId: 'm-unwritable', type: 'gap', fromSeq: 0, toSeq: 1 }),
    ).resolves.toBeUndefined();

    // Once the directory is writable again (mock exhausted -> falls through to the real mkdir), logging resumes normally.
    await logEvent('m-unwritable', { t: Date.now(), meetingId: 'm-unwritable', type: 'gap', fromSeq: 1, toSeq: 2 });
    expect(await readJsonLines(diagnosticsFile('m-unwritable'))).toHaveLength(1);
  });

  it('uploadRoomCopy never includes profileId, real profile ids, or profile-match events', async () => {
    await logEvent('m-room', {
      t: Date.now(),
      meetingId: 'm-room',
      type: 'profile-match',
      sessionSpeakerId: 'ss-1',
      attempt: 1,
      best: { profile: 'profile-real-id', cos: 0.6 },
      second: null,
      threshold: 0.5,
      accepted: true,
    });
    await logEvent('m-room', {
      t: Date.now(),
      meetingId: 'm-room',
      type: 'enrol',
      profile: 'profile-real-id',
      source: 'user-post',
      coherence: 0.9,
      durationSec: 10,
      vectorCountAfter: 2,
    });
    await logEvent('m-room', {
      t: Date.now(),
      meetingId: 'm-room',
      type: 'observe',
      seq: 0,
      label: 's0:1',
      startMs: 0,
      endMs: 3000,
      durSec: 3,
      final: true,
      targetId: 'ss-1',
      decisionScore: 0.9,
      scores: [],
      sticky: true,
      action: 'folded',
    });

    let uploadedText = '';
    const hub = {
      authorizedFetch: vi.fn(async (_path: string, init: { body: FormData }) => {
        const file = init.body.get('files') as File;
        uploadedText = await file.text();
        return { ok: true, status: 200, json: async () => ({ success: true, file: { _id: 'file-1' } }) } as unknown as Response;
      }),
    } as unknown as RoomBoundHubClient;

    await uploadRoomCopy(hub, 'room-1', 'folder-1', 'm-room');

    expect(hub.authorizedFetch).toHaveBeenCalledTimes(1);
    const lines = uploadedText
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Record<string, unknown>);

    expect(lines.some((l) => l.type === 'profile-match')).toBe(false);
    expect(JSON.stringify(lines)).not.toContain('profile-real-id');
    expect(JSON.stringify(lines)).not.toContain('profileId');
    const enrolLine = lines.find((l) => l.type === 'enrol')!;
    expect(enrolLine.profile).toBe('p1'); // aliased, not the real id
    expect(lines.find((l) => l.type === 'observe')).toBeDefined();
  });

  it('uploadRoomCopy is a no-op (never throws) when the meeting has no local log', async () => {
    const hub = { authorizedFetch: vi.fn() } as unknown as RoomBoundHubClient;
    await expect(uploadRoomCopy(hub, 'room-1', 'folder-1', 'm-never-recorded')).resolves.toBeUndefined();
    expect(hub.authorizedFetch).not.toHaveBeenCalled();
  });
});
