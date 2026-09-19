/**
 * Security (data loss) — plan.md Red Team FM F5/S2-10 and the P8 acceptance
 * criterion: two meetings in the SAME room, on the SAME day, with the SAME
 * title must never share a folder or a part file, and `concatParts` must
 * never let one meeting's part slip into the other's concat — even when an
 * attacker (or a buggy caller) hands it a part name carrying the OTHER
 * meeting's digest. `meeting-slug.test.ts` already covers `folderName`/
 * `partFileName` in isolation; this test proves the two meetings' outputs
 * stay disjoint end to end and that `concatParts` rejects cross-contamination.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoomBoundHubClient } from '@privos_ai/app-server';

import { folderName, partFileName } from '../../shared/meeting-slug.js';
import { concatParts, type PartRef } from './concat-parts.js';

function streamFromBuffer(buf: Buffer): ReadableStream {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(buf));
      controller.close();
    },
  });
}

function fakeHub(bytesByFileId: Record<string, Buffer>): RoomBoundHubClient {
  return {
    authorizedFetch: vi.fn(async (requestPath: string) => {
      const match = /file-management\.files\/([^/]+)\/download/.exec(requestPath);
      const fileId = match ? decodeURIComponent(match[1]) : '';
      const bytes = bytesByFileId[fileId];
      if (!bytes) return { ok: false, status: 404, body: null } as unknown as Response;
      return { ok: true, status: 200, body: streamFromBuffer(bytes) } as unknown as Response;
    }),
  };
}

const SAME_DATE = new Date('2026-09-18T09:00:00Z');
const SAME_TITLE = 'Họp đứng hàng ngày';

describe('two meetings — same room, same date, same title', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'folder-collision-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('get DISTINCT folder paths (meetingId8 collision guard)', () => {
    const meetingA = 'aaaaaaaa1111';
    const meetingB = 'bbbbbbbb2222';
    const folderA = folderName(SAME_TITLE, meetingA, SAME_DATE);
    const folderB = folderName(SAME_TITLE, meetingB, SAME_DATE);
    expect(folderA).not.toBe(folderB);
    expect(folderA).toBe(`Meetings/2026-09-18-hop-dung-hang-ngay-aaaaaaaa`);
    expect(folderB).toBe(`Meetings/2026-09-18-hop-dung-hang-ngay-bbbbbbbb`);
  });

  it('get DISTINCT part file names for the same seq number', () => {
    const meetingA = 'aaaaaaaa1111';
    const meetingB = 'bbbbbbbb2222';
    expect(partFileName(0, meetingA)).not.toBe(partFileName(0, meetingB));
  });

  it("concatParts for meeting A never reads meeting B's part even if handed its fileId+name", async () => {
    const meetingA = 'aaaaaaaa1111';
    const meetingB = 'bbbbbbbb2222';
    const partsClaimedForA: PartRef[] = [
      { fileId: 'file-a0', seq: 0, name: partFileName(0, meetingA) },
      // A part that actually belongs to meeting B, smuggled in with A's fileId list bypassed (attacker/bug scenario).
      { fileId: 'file-b1', seq: 1, name: partFileName(1, meetingB) },
    ];
    const hub = fakeHub({ 'file-a0': Buffer.from('A-AUDIO'), 'file-b1': Buffer.from('B-AUDIO') });
    const dest = path.join(dir, 'audio.webm');

    await expect(
      concatParts(hub, meetingA, partsClaimedForA, ['file-a0', 'file-b1'], dest, new AbortController().signal),
    ).rejects.toThrow(/meeting signature/i);
  });

  it('concatParts each meeting on its own job produces independent, non-overwriting output', async () => {
    const meetingA = 'aaaaaaaa1111';
    const meetingB = 'bbbbbbbb2222';
    const hub = fakeHub({
      'file-a0': Buffer.from('AUDIO-A-PART-0'),
      'file-b0': Buffer.from('AUDIO-B-PART-0'),
    });

    const destA = path.join(dir, folderName(SAME_TITLE, meetingA, SAME_DATE).split('/').pop()! + '-audio-a.webm');
    const destB = path.join(dir, folderName(SAME_TITLE, meetingB, SAME_DATE).split('/').pop()! + '-audio-b.webm');

    await concatParts(hub, meetingA, [{ fileId: 'file-a0', seq: 0, name: partFileName(0, meetingA) }], ['file-a0'], destA, new AbortController().signal);
    await concatParts(hub, meetingB, [{ fileId: 'file-b0', seq: 0, name: partFileName(0, meetingB) }], ['file-b0'], destB, new AbortController().signal);

    const [bytesA, bytesB] = await Promise.all([readFile(destA), readFile(destB)]);
    expect(bytesA.toString('utf8')).toBe('AUDIO-A-PART-0');
    expect(bytesB.toString('utf8')).toBe('AUDIO-B-PART-0');
  });
});
