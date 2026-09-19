import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoomBoundHubClient } from '@privos_ai/app-server';

import { concatParts, deletePartFiles, type PartRef } from './concat-parts.js';

function streamFromBuffer(buf: Buffer): ReadableStream {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(buf));
      controller.close();
    },
  });
}

function fakeHub(bytesByFileId: Record<string, Buffer>, deleted: string[] = []): RoomBoundHubClient {
  return {
    authorizedFetch: vi.fn(async (requestPath: string, init: RequestInit) => {
      if (init.method === 'DELETE') {
        deleted.push(decodeURIComponent(requestPath.split('/').pop() ?? ''));
        return { ok: true, status: 200, json: async () => ({ success: true }) } as unknown as Response;
      }
      const match = /file-management\.files\/([^/]+)\/download/.exec(requestPath);
      const fileId = match ? decodeURIComponent(match[1]) : '';
      const bytes = bytesByFileId[fileId];
      if (!bytes) return { ok: false, status: 404, body: null } as unknown as Response;
      return { ok: true, status: 200, body: streamFromBuffer(bytes) } as unknown as Response;
    }),
  };
}

const MEETING_ID = 'meeting12345678';
const DIGEST = MEETING_ID.slice(0, 8);

describe('concatParts', () => {
  let dir: string;
  let dest: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'concat-test-'));
    dest = path.join(dir, 'audio.webm');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('appends parts in seq order and matches the expected byte output', async () => {
    const parts: PartRef[] = [
      { fileId: 'f0', seq: 0, name: `audio.part-0000-${DIGEST}.webm` },
      { fileId: 'f1', seq: 1, name: `audio.part-0001-${DIGEST}.webm` },
    ];
    const hub = fakeHub({ f0: Buffer.from('AAA'), f1: Buffer.from('BBB') });
    await concatParts(hub, MEETING_ID, parts, ['f0', 'f1'], dest, new AbortController().signal);
    const out = await readFile(dest);
    expect(out.toString('utf8')).toBe('AAABBB');
  });

  it('throws a clear error when a part is missing from the sequence', async () => {
    const parts: PartRef[] = [
      { fileId: 'f0', seq: 0, name: `audio.part-0000-${DIGEST}.webm` },
      { fileId: 'f2', seq: 2, name: `audio.part-0002-${DIGEST}.webm` },
    ];
    const hub = fakeHub({ f0: Buffer.from('AAA'), f2: Buffer.from('CCC') });
    await expect(concatParts(hub, MEETING_ID, parts, ['f0', 'f2'], dest, new AbortController().signal)).rejects.toThrow(/missing part/i);
  });

  it("rejects a part whose fileId is not in the job's own partFileIds", async () => {
    const parts: PartRef[] = [{ fileId: 'foreign', seq: 0, name: `audio.part-0000-${DIGEST}.webm` }];
    const hub = fakeHub({ foreign: Buffer.from('AAA') });
    await expect(concatParts(hub, MEETING_ID, parts, ['f0'], dest, new AbortController().signal)).rejects.toThrow(/does not match/i);
  });

  it("rejects a part whose name does not carry this meeting's digest (a different meeting's part)", async () => {
    const parts: PartRef[] = [{ fileId: 'f0', seq: 0, name: 'audio.part-0000-otherid8.webm' }];
    const hub = fakeHub({ f0: Buffer.from('AAA') });
    await expect(concatParts(hub, MEETING_ID, parts, ['f0'], dest, new AbortController().signal)).rejects.toThrow(/meeting signature/i);
  });

  it('deletePartFiles only deletes the given fileIds, never scans a folder', async () => {
    const deleted: string[] = [];
    const hub = fakeHub({}, deleted);
    await deletePartFiles(hub, ['a', 'b']);
    expect(deleted.sort()).toEqual(['a', 'b']);
  });
});
