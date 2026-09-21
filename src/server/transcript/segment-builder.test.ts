import { describe, expect, it } from 'vitest';

import type { SttToken } from '../stt/stt-provider.js';
import { buildSegments } from './segment-builder.js';

function token(overrides: Partial<SttToken>): SttToken {
  return { text: 'hi', startMs: 0, endMs: 100, ...overrides };
}

describe('buildSegments', () => {
  it('returns an empty array for no tokens', () => {
    expect(buildSegments([])).toEqual([]);
  });

  it('cuts a new segment when the speaker changes', () => {
    const tokens = [
      token({ text: 'hello', startMs: 0, endMs: 500, speaker: 'a' }),
      token({ text: 'world', startMs: 500, endMs: 900, speaker: 'b' }),
    ];
    const segments = buildSegments(tokens);
    expect(segments).toHaveLength(2);
    expect(segments[0].speakerId).toBe('a');
    expect(segments[1].speakerId).toBe('b');
  });

  it('cuts a new segment when the language changes', () => {
    const tokens = [
      token({ text: 'xin chao', startMs: 0, endMs: 500, speaker: 'a', language: 'vi' }),
      token({ text: 'hello', startMs: 500, endMs: 900, speaker: 'a', language: 'en' }),
    ];
    const segments = buildSegments(tokens);
    expect(segments).toHaveLength(2);
    expect(segments[0].lang).toBe('vi');
    expect(segments[1].lang).toBe('en');
  });

  it('cuts a new segment after a pause longer than pauseSplitSec', () => {
    const tokens = [
      token({ text: 'one', startMs: 0, endMs: 500, speaker: 'a' }),
      token({ text: 'two', startMs: 3000, endMs: 3500, speaker: 'a' }),
    ];
    const segments = buildSegments(tokens, { pauseSplitSec: 1.5 });
    expect(segments).toHaveLength(2);
  });

  it('assigns a token missing `speaker` to the previous speaker', () => {
    const tokens = [
      token({ text: 'one', startMs: 0, endMs: 500, speaker: 'a' }),
      token({ text: 'two', startMs: 500, endMs: 900, speaker: undefined }),
    ];
    const segments = buildSegments(tokens);
    expect(segments).toHaveLength(1);
    expect(segments[0].speakerId).toBe('a');
    expect(segments[0].text).toContain('two');
  });

  it('merges a segment shorter than minSegmentSec into the previous same-speaker segment', () => {
    const tokens = [
      token({ text: 'one', startMs: 0, endMs: 1000, speaker: 'a', language: 'vi' }),
      token({ text: 'blip', startMs: 1000, endMs: 1100, speaker: 'a', language: 'en' }),
      token({ text: 'more', startMs: 1100, endMs: 1300, speaker: 'a', language: 'vi' }),
    ];
    const segments = buildSegments(tokens, { minSegmentSec: 0.3 });
    expect(segments.every((s) => s.speakerId === 'a')).toBe(true);
    expect(segments.some((s) => s.text.includes('blip'))).toBe(true);
  });

  it('concatenates soniox subword tokens when tokensCarrySpacing is set (no space shredding)', () => {
    // Soniox returns Vietnamese "lĩnh" as separate subword tokens with no
    // spaces; space-joining them yields "l ĩ nh" — the bug this option fixes.
    const tokens: SttToken[] = [
      token({ text: 'l', startMs: 0, endMs: 100, speaker: 'a', language: 'vi' }),
      token({ text: 'ĩ', startMs: 100, endMs: 200, speaker: 'a', language: 'vi' }),
      token({ text: 'nh', startMs: 200, endMs: 300, speaker: 'a', language: 'vi' }),
      token({ text: ' vực', startMs: 300, endMs: 500, speaker: 'a', language: 'vi' }),
    ];
    expect(buildSegments(tokens, { tokensCarrySpacing: true })[0].text).toBe('lĩnh vực');
    // Default (elevenlabs bare-word) behavior is unchanged: space-joined.
    expect(buildSegments(tokens)[0].text).toBe('l ĩ nh vực');
  });

  it('produces the same Segment shape for a soniox-style and an elevenlabs-style fixture', () => {
    const sonioxTokens: SttToken[] = [
      token({ text: ' Hello', startMs: 0, endMs: 400, speaker: 'speaker_1', language: 'en', confidence: 0.9 }),
      token({ text: ' there', startMs: 400, endMs: 800, speaker: 'speaker_1', language: 'en', confidence: 0.9 }),
    ];
    const elevenTokens: SttToken[] = [
      token({ text: 'Hello', startMs: 0, endMs: 400, speaker: 'speaker_0', confidence: 0.8 }),
      token({ text: 'there', startMs: 400, endMs: 800, speaker: 'speaker_0', confidence: 0.8 }),
    ];
    const a = buildSegments(sonioxTokens);
    const b = buildSegments(elevenTokens);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(typeof a[0].text).toBe('string');
    expect(typeof b[0].text).toBe('string');
  });
});
