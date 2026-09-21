import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

// Isolates every write this test file makes under a throwaway temp dir —
// `dataDir` (paths.ts) reads `MEETING_DATA_DIR` ONCE at module-eval time, so
// this MUST run before the dynamic import below.
const tempDataDir = mkdtempSync(path.join(tmpdir(), 'meeting-agent-diagnostics-retention-'));
process.env.MEETING_DATA_DIR = tempDataDir;
afterAll(() => {
  delete process.env.MEETING_DATA_DIR;
  rmSync(tempDataDir, { recursive: true, force: true });
});

const { sweepLocal } = await import('./speaker-diagnostics-retention.js');

describe('sweepLocal', () => {
  const dir = path.join(tempDataDir, 'diagnostics');

  beforeEach(async () => {
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
  });

  it('enforces a byte cap, deleting the oldest files first', async () => {
    const files = ['old.jsonl', 'middle.jsonl', 'new.jsonl'];
    for (const name of files) {
      await writeFile(path.join(dir, name), 'x'.repeat(100), 'utf8');
    }
    const now = Date.now();
    await utimes(path.join(dir, 'old.jsonl'), new Date(now - 3000), new Date(now - 3000));
    await utimes(path.join(dir, 'middle.jsonl'), new Date(now - 2000), new Date(now - 2000));
    await utimes(path.join(dir, 'new.jsonl'), new Date(now - 1000), new Date(now - 1000));

    // Cap of 150 bytes with 3x100-byte files -> the two oldest must go, only the newest survives.
    const result = await sweepLocal({ maxTotalBytes: 150, maxAgeDays: 9999 });

    expect(result.deletedByCap).toBe(2);
    await expect(readFile(path.join(dir, 'old.jsonl'))).rejects.toThrow();
    await expect(readFile(path.join(dir, 'middle.jsonl'))).rejects.toThrow();
    await expect(readFile(path.join(dir, 'new.jsonl'), 'utf8')).resolves.toHaveLength(100);
  });

  it('deletes files older than maxAgeDays regardless of the byte cap', async () => {
    await writeFile(path.join(dir, 'ancient.jsonl'), 'x', 'utf8');
    const veryOld = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000);
    await utimes(path.join(dir, 'ancient.jsonl'), veryOld, veryOld);

    const result = await sweepLocal({ maxAgeDays: 90, maxTotalBytes: Number.MAX_SAFE_INTEGER });
    expect(result.deletedByAge).toBe(1);
    await expect(readFile(path.join(dir, 'ancient.jsonl'))).rejects.toThrow();
  });

  it('deletes nothing and never throws on an already-clean directory', async () => {
    const result = await sweepLocal({ maxAgeDays: 9999, maxTotalBytes: Number.MAX_SAFE_INTEGER });
    expect(result).toEqual({ deletedByAge: 0, deletedByCap: 0, deletedOrphaned: 0 });
  });

  it('deletes a file whose meetingId is absent from existingMeetingIds, regardless of age or cap', async () => {
    await writeFile(path.join(dir, 'gone.jsonl'), 'x', 'utf8');
    await writeFile(path.join(dir, 'kept.jsonl'), 'x', 'utf8');

    const result = await sweepLocal({ maxAgeDays: 9999, maxTotalBytes: Number.MAX_SAFE_INTEGER, existingMeetingIds: new Set(['kept']) });

    expect(result.deletedOrphaned).toBe(1);
    await expect(readFile(path.join(dir, 'gone.jsonl'))).rejects.toThrow();
    await expect(readFile(path.join(dir, 'kept.jsonl'), 'utf8')).resolves.toBe('x');
  });
});
