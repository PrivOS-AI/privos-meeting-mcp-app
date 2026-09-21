import { describe, expect, it } from 'vitest';

import { computeAttributionReport, parsePartSeq, resolveTruePersonByTurnKey, type ObserveEventLike } from './replay-attribution.js';

describe('parsePartSeq', () => {
  it('extracts the zero-padded seq from the production part-file naming', () => {
    expect(parsePartSeq('audio.part-0007-ab12cd34.webm')).toBe(7);
    expect(parsePartSeq('audio.part-0000-ab12cd34.webm')).toBe(0);
  });

  it('returns null for a name that does not match', () => {
    expect(parsePartSeq('audio.webm')).toBeNull();
    expect(parsePartSeq('notes.txt')).toBeNull();
  });
});

describe('resolveTruePersonByTurnKey', () => {
  const observeEvents: ObserveEventLike[] = [
    { type: 'observe', label: 's0:1', startMs: 0, targetId: 'ss-1' },
    { type: 'observe', label: 's0:1', startMs: 3000, targetId: 'ss-1' },
    { type: 'observe', label: 's0:2', startMs: 6000, targetId: 'ss-2' },
  ];

  it('maps label:startMs -> person via the ORIGINAL targetId, not the label', () => {
    const truth = resolveTruePersonByTurnKey(observeEvents, { speakers: { 'ss-1': 'An', 'ss-2': 'Binh' } });
    expect(truth.get('s0:1:0')).toBe('An');
    expect(truth.get('s0:1:3000')).toBe('An');
    expect(truth.get('s0:2:6000')).toBe('Binh');
  });

  it('an unlabeled sessionSpeakerId produces no ground truth for its turns', () => {
    const truth = resolveTruePersonByTurnKey(observeEvents, { speakers: { 'ss-1': 'An' } });
    expect(truth.has('s0:2:6000')).toBe(false);
  });

  it('excludeTurns (keyed by targetId:startMs) drops a turn even though its speaker is labeled', () => {
    const truth = resolveTruePersonByTurnKey(observeEvents, { speakers: { 'ss-1': 'An' }, excludeTurns: ['ss-1:3000'] });
    expect(truth.get('s0:1:0')).toBe('An');
    expect(truth.has('s0:1:3000')).toBe(false);
  });

  it('overrideTurns (keyed by targetId:startMs) replaces the speaker\'s default person for one turn', () => {
    const truth = resolveTruePersonByTurnKey(observeEvents, { speakers: { 'ss-1': 'An' }, overrideTurns: { 'ss-1:3000': 'Binh' } });
    expect(truth.get('s0:1:0')).toBe('An');
    expect(truth.get('s0:1:3000')).toBe('Binh');
  });
});

describe('computeAttributionReport', () => {
  it('100% accuracy when every replay speaker\'s turns all belong to one true person', () => {
    const replayTargetByTurnKey = new Map([
      ['s0:1:0', 'replay-A'],
      ['s0:1:3000', 'replay-A'],
      ['s0:2:6000', 'replay-B'],
    ]);
    const truePersonByTurnKey = new Map([
      ['s0:1:0', 'An'],
      ['s0:1:3000', 'An'],
      ['s0:2:6000', 'Binh'],
    ]);
    const report = computeAttributionReport(replayTargetByTurnKey, truePersonByTurnKey);
    expect(report).toEqual({ totalLabeledTurns: 3, correctTurns: 3, accuracy: 1, falseMergedPeople: [], falseSplitPeople: [] });
  });

  it('flags a FALSE MERGE when one replay speaker mixed two true people\'s turns', () => {
    const replayTargetByTurnKey = new Map([
      ['s0:1:0', 'replay-A'],
      ['s0:2:6000', 'replay-A'], // An and Binh both folded into the SAME replay speaker
    ]);
    const truePersonByTurnKey = new Map([
      ['s0:1:0', 'An'],
      ['s0:2:6000', 'Binh'],
    ]);
    const report = computeAttributionReport(replayTargetByTurnKey, truePersonByTurnKey);
    expect(report.falseMergedPeople).toEqual([['An', 'Binh']]);
    expect(report.correctTurns).toBe(1); // only the majority person's own turn counts as correct
    expect(report.accuracy).toBeCloseTo(0.5);
  });

  it('flags a FALSE SPLIT when one true person\'s turns land in two different (never-merged) replay speakers', () => {
    const replayTargetByTurnKey = new Map([
      ['s0:1:0', 'replay-A'],
      ['s0:1:9000', 'replay-C'], // same person (An), but the provider recycled the label into a brand-new instance that never merged back
    ]);
    const truePersonByTurnKey = new Map([
      ['s0:1:0', 'An'],
      ['s0:1:9000', 'An'],
    ]);
    const report = computeAttributionReport(replayTargetByTurnKey, truePersonByTurnKey);
    expect(report.falseSplitPeople).toEqual(['An']);
    expect(report.correctTurns).toBe(2); // both turns still correctly named "An", just under two different session speakers
  });

  it('a turn with no ground truth (unlabeled) is excluded from totals entirely', () => {
    const replayTargetByTurnKey = new Map([
      ['s0:1:0', 'replay-A'],
      ['s0:9:9000', 'replay-Z'],
    ]);
    const truePersonByTurnKey = new Map([['s0:1:0', 'An']]);
    const report = computeAttributionReport(replayTargetByTurnKey, truePersonByTurnKey);
    expect(report.totalLabeledTurns).toBe(1);
    expect(report.correctTurns).toBe(1);
  });
});
