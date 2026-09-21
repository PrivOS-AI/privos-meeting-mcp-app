import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readWavPcm } from '../src/server/media/decode-audio.js';
import { encodeWav } from './wav-writer.js';

describe('encodeWav', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'encode-wav-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('round-trips through readWavPcm (decode-audio.ts\'s own reader) at the sample level', async () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1, -1, 0.25]);
    const wavPath = path.join(tmpDir, 'clip.wav');
    await writeFile(wavPath, encodeWav(samples, 16_000));

    const roundTripped = await readWavPcm(wavPath, 0, samples.length / 16_000);
    expect(roundTripped.length).toBe(samples.length);
    for (let i = 0; i < samples.length; i++) {
      expect(roundTripped[i]).toBeCloseTo(samples[i], 3);
    }
  });

  it('clamps out-of-range samples instead of wrapping', async () => {
    const samples = new Float32Array([2, -2]); // beyond [-1, 1]
    const wavPath = path.join(tmpDir, 'clip.wav');
    await writeFile(wavPath, encodeWav(samples, 16_000));

    const roundTripped = await readWavPcm(wavPath, 0, samples.length / 16_000);
    expect(roundTripped[0]).toBeCloseTo(1, 2);
    expect(roundTripped[1]).toBeCloseTo(-1, 2);
  });
});
