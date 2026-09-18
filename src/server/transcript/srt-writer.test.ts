import { describe, expect, it } from 'vitest';

import type { Segment } from './segment-builder.js';
import { buildSrt } from './srt-writer.js';

describe('buildSrt', () => {
  it('formats one cue per short segment with HH:MM:SS,mmm timestamps', () => {
    const segments: Segment[] = [{ id: 'seg-0', speakerId: 'a', startSec: 1, endSec: 2.5, text: 'Xin chào', lang: 'vi', tokenCount: 2 }];
    const srt = buildSrt(segments);
    expect(srt).toContain('1\n00:00:01,000 --> 00:00:02,500\nXin chào\n');
  });

  it('returns nothing for an empty segment list', () => {
    expect(buildSrt([])).toBe('');
  });

  it('splits a segment longer than 7s into multiple cues at token boundaries', () => {
    const segments: Segment[] = [{ id: 'seg-0', speakerId: 'a', startSec: 0, endSec: 16, text: 'long segment', lang: 'vi', tokenCount: 4 }];
    const tokens = [
      { text: 'one', startMs: 0, endMs: 4000 },
      { text: 'two', startMs: 4000, endMs: 8000 },
      { text: 'three', startMs: 8000, endMs: 12000 },
      { text: 'four', startMs: 12000, endMs: 16000 },
    ];
    const srt = buildSrt(segments, tokens);
    const cueCount = srt.trim().split('\n\n').length;
    expect(cueCount).toBeGreaterThan(1);
    expect(srt).toMatch(/\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}/);
  });
});
