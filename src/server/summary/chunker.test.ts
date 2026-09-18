import { describe, expect, it } from 'vitest';

import type { Segment } from '../transcript/segment-builder.js';
import { chunkTranscript } from './chunker.js';

function segment(overrides: Partial<Segment>): Segment {
  return {
    id: 'seg-0',
    speakerId: 'spk1',
    startSec: 0,
    endSec: 1,
    text: 'hello',
    lang: 'vi',
    tokenCount: 1,
    ...overrides,
  };
}

describe('chunkTranscript', () => {
  it('keeps a short transcript in one chunk with the speaker name substituted', () => {
    const segments = [segment({ id: 's1', speakerId: 'spk1', startSec: 0, endSec: 2, text: 'xin chào' })];
    const chunks = chunkTranscript(segments, { spk1: 'Thanh' });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toContain('Thanh: xin chào');
    expect(chunks[0].segmentCount).toBe(1);
  });

  it('falls back to the raw speakerId when no name is provided', () => {
    const segments = [segment({ id: 's1', speakerId: 'spkX' })];
    const chunks = chunkTranscript(segments, {});
    expect(chunks[0].text).toContain('spkX: hello');
  });

  it('splits a long (3h) transcript into ~12-minute windows at segment boundaries', () => {
    const segments: Segment[] = [];
    for (let i = 0; i < 3 * 60 * 6; i++) {
      // one 10s segment every 10s for 3 hours = 1080 segments, ~15 windows of 12 minutes
      segments.push(segment({ id: `s${i}`, startSec: i * 10, endSec: i * 10 + 9, text: `line ${i}` }));
    }
    const chunks = chunkTranscript(segments, {});
    expect(chunks.length).toBeGreaterThanOrEqual(14);
    expect(chunks.length).toBeLessThanOrEqual(16);
    // never cuts mid-segment: every chunk's segmentCount sums back to the total.
    expect(chunks.reduce((sum, c) => sum + c.segmentCount, 0)).toBe(segments.length);
    // chunks are contiguous and ordered.
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].startSec).toBeGreaterThanOrEqual(chunks[i - 1].endSec);
      expect(chunks[i].index).toBe(i);
    }
  });

  it('keeps one very long single segment as its own chunk (never split mid-segment by the time window)', () => {
    const segments = [segment({ id: 's1', startSec: 0, endSec: 2000, text: 'a very long monologue' })];
    const chunks = chunkTranscript(segments, {}, { windowSec: 720 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].segmentCount).toBe(1);
  });

  it('splits a window whose rendered text exceeds the Hub AI prompt budget into further chunks', () => {
    const longText = 'x'.repeat(2_000);
    const segments: Segment[] = [];
    for (let i = 0; i < 30; i++) {
      segments.push(segment({ id: `s${i}`, startSec: i * 5, endSec: i * 5 + 4, text: longText }));
    }
    // ~30 * 2000+ chars of rendered text, well over a tiny budget -> forces the char-budget split.
    const chunks = chunkTranscript(segments, {}, { windowSec: 10_000, promptOverheadChars: 49_000 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(1_000 + 2_100); // maxTextChars floor (1000) + one line's slack
    }
    expect(chunks.reduce((sum, c) => sum + c.segmentCount, 0)).toBe(segments.length);
  });

  it('returns an empty array for no segments', () => {
    expect(chunkTranscript([], {})).toEqual([]);
  });
});
