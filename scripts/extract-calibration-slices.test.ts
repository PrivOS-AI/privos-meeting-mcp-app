import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readObserveTurns, sanitizeFolderName } from './extract-calibration-slices.js';

describe('sanitizeFolderName', () => {
  it('leaves a normal name untouched', () => {
    expect(sanitizeFolderName('An Nguyen')).toBe('An Nguyen');
  });

  it('replaces path-unsafe characters with underscores', () => {
    expect(sanitizeFolderName('A/B\\C:D*E?F"G<H>I|J')).toBe('A_B_C_D_E_F_G_H_I_J');
  });

  it('falls back to "unknown" for an empty/whitespace-only name', () => {
    expect(sanitizeFolderName('   ')).toBe('unknown');
  });
});

describe('readObserveTurns', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'read-observe-turns-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('extracts only type:"observe" lines, tolerating a corrupt line and other event types', async () => {
    const lines = [
      JSON.stringify({ t: 1, meetingId: 'm1', type: 'chunk', seq: 0 }),
      JSON.stringify({ t: 2, meetingId: 'm1', type: 'observe', targetId: 'ss-1', startMs: 0, endMs: 3000, durSec: 3 }),
      'not valid json {{{',
      JSON.stringify({ t: 3, meetingId: 'm1', type: 'observe', targetId: 'ss-2', startMs: 3000, endMs: 6000, durSec: 3 }),
      JSON.stringify({ t: 4, meetingId: 'm1', type: 'merge', winnerId: 'ss-1', loserId: 'ss-2' }),
    ];
    const filePath = path.join(tmpDir, 'diagnostics.jsonl');
    await writeFile(filePath, `${lines.join('\n')}\n`);

    const turns = await readObserveTurns(filePath);
    expect(turns).toEqual([
      { targetId: 'ss-1', startMs: 0, endMs: 3000, durSec: 3 },
      { targetId: 'ss-2', startMs: 3000, endMs: 6000, durSec: 3 },
    ]);
  });

  it('skips an observe-typed line missing a required numeric/string field', async () => {
    const filePath = path.join(tmpDir, 'diagnostics.jsonl');
    await writeFile(filePath, `${JSON.stringify({ type: 'observe', targetId: 'ss-1', startMs: 0, endMs: 3000 })}\n`); // no durSec
    expect(await readObserveTurns(filePath)).toEqual([]);
  });
});
