import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readCalibrationLabels, turnKey } from './calibration-labels.js';

describe('turnKey', () => {
  it('joins targetId and startMs with a colon — the same key labels.json\'s excludeTurns/overrideTurns use', () => {
    expect(turnKey('ss-1', 12000)).toBe('ss-1:12000');
  });
});

describe('readCalibrationLabels', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'read-labels-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('parses speakers/excludeTurns/overrideTurns, defaulting the optional fields to empty', async () => {
    const filePath = path.join(tmpDir, 'labels.json');
    await writeFile(filePath, JSON.stringify({ speakers: { 'ss-1': 'An' } }));
    expect(await readCalibrationLabels(filePath)).toEqual({ speakers: { 'ss-1': 'An' }, excludeTurns: [], overrideTurns: {} });
  });

  it('passes through explicit excludeTurns/overrideTurns unchanged', async () => {
    const filePath = path.join(tmpDir, 'labels.json');
    const input = { speakers: { 'ss-1': 'An' }, excludeTurns: ['ss-1:3000'], overrideTurns: { 'ss-1:6000': 'Binh' } };
    await writeFile(filePath, JSON.stringify(input));
    expect(await readCalibrationLabels(filePath)).toEqual(input);
  });

  it('rejects a labels file with no "speakers" object', async () => {
    const filePath = path.join(tmpDir, `labels-${randomBytes(4).toString('hex')}.json`);
    await writeFile(filePath, JSON.stringify({ excludeTurns: [] }));
    await expect(readCalibrationLabels(filePath)).rejects.toThrow(/must have a "speakers" object/);
  });
});
