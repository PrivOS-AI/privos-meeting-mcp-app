import { describe, expect, it } from 'vitest';

import { speakerForWord, tokensToSegments, wordsToTokens } from './local-async-provider.js';

const turns = [
  { startSec: 0, endSec: 5, speaker: 0 },
  { startSec: 5, endSec: 9, speaker: 1 },
];

describe('speakerForWord', () => {
  it('takes the turn the word overlaps most', () => {
    expect(speakerForWord({ startSec: 4.6, endSec: 5.8 }, turns)).toBe(1);
    expect(speakerForWord({ startSec: 4.0, endSec: 5.2 }, turns)).toBe(0);
  });

  it('falls back to the nearest turn in a gap, and to null with no diarization', () => {
    expect(speakerForWord({ startSec: 9.5, endSec: 9.8 }, turns)).toBe(1);
    expect(speakerForWord({ startSec: 1, endSec: 2 }, [])).toBeNull();
  });
});

describe('wordsToTokens / tokensToSegments', () => {
  it('labels every word with its speaker and groups consecutive words into segments', () => {
    const tokens = wordsToTokens(
      [
        { text: ' Xin', startSec: 1, endSec: 1.4, lang: 'vi', confidence: 0.9 },
        { text: ' chào', startSec: 1.4, endSec: 2, lang: 'vi', confidence: 0.9 },
        { text: ' Hello', startSec: 6, endSec: 6.5, lang: 'en', confidence: 0.8 },
      ],
      turns,
    );
    expect(tokens.map((t) => [t.text, t.speaker, t.startMs, t.endMs])).toEqual([
      [' Xin', 'speaker_0', 1000, 1400],
      [' chào', 'speaker_0', 1400, 2000],
      [' Hello', 'speaker_1', 6000, 6500],
    ]);
    expect(tokensToSegments(tokens)).toEqual([
      { speaker: 'speaker_0', startMs: 1000, endMs: 2000, text: 'Xin chào', language: 'vi' },
      { speaker: 'speaker_1', startMs: 6000, endMs: 6500, text: 'Hello', language: 'en' },
    ]);
  });

  it('puts everyone on speaker_0 when diarization found no turns', () => {
    const tokens = wordsToTokens([{ text: ' A', startSec: 0, endSec: 1, lang: 'vi', confidence: 1 }], []);
    expect(tokens[0].speaker).toBe('speaker_0');
  });
});
