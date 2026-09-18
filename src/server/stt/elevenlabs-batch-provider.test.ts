import { afterEach, describe, expect, it } from 'vitest';

import { env } from '../env.js';
import { mapWordsToTokens, type ElevenWord } from './elevenlabs-batch-provider.js';

describe('mapWordsToTokens', () => {
  it('maps a plain word with a speaker to an SttToken', () => {
    const words: ElevenWord[] = [{ text: 'Hello', start: 0, end: 0.5, type: 'word', speakerId: 'speaker_0', logprob: -0.1 }];
    const tokens = mapWordsToTokens(words);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({ text: 'Hello', startMs: 0, endMs: 500, speaker: 'speaker_0' });
    expect(tokens[0].confidence).toBeCloseTo(Math.exp(-0.1));
  });

  it('drops spacing-type words', () => {
    const words: ElevenWord[] = [
      { text: 'Hello', start: 0, end: 0.5, type: 'word', speakerId: 's0', logprob: 0 },
      { text: ' ', start: 0.5, end: 0.5, type: 'spacing', logprob: 0 },
      { text: 'world', start: 0.5, end: 1, type: 'word', speakerId: 's0', logprob: 0 },
    ];
    const tokens = mapWordsToTokens(words);
    expect(tokens.map((t) => t.text)).toEqual(['Hello', 'world']);
  });

  it('keeps an audio_event as bracketed text', () => {
    const words: ElevenWord[] = [{ text: 'laughter', start: 1, end: 1.2, type: 'audio_event', logprob: 0 }];
    expect(mapWordsToTokens(words)[0].text).toBe('[laughter]');
  });

  it('handles a change in speaker across consecutive words', () => {
    const words: ElevenWord[] = [
      { text: 'hi', start: 0, end: 0.3, type: 'word', speakerId: 'speaker_0', logprob: 0 },
      { text: 'there', start: 0.3, end: 0.6, type: 'word', speakerId: 'speaker_1', logprob: 0 },
    ];
    const tokens = mapWordsToTokens(words);
    expect(tokens[0].speaker).toBe('speaker_0');
    expect(tokens[1].speaker).toBe('speaker_1');
  });

  it('returns an empty array for no words', () => {
    expect(mapWordsToTokens([])).toEqual([]);
  });

  it('leaves speaker undefined for a word with no speakerId', () => {
    const words: ElevenWord[] = [{ text: 'solo', start: 0, end: 0.2, type: 'word', logprob: 0 }];
    expect(mapWordsToTokens(words)[0].speaker).toBeUndefined();
  });
});

describe('elevenLabsBatchProvider.transcribeFile', () => {
  const originalKey = env.elevenLabsApiKey;

  afterEach(() => {
    env.elevenLabsApiKey = originalKey;
  });

  it('throws a clear error when ELEVENLABS_API_KEY is missing', async () => {
    env.elevenLabsApiKey = undefined;
    const { elevenLabsBatchProvider } = await import('./elevenlabs-batch-provider.js');
    await expect(elevenLabsBatchProvider.transcribeFile({ audioPath: '/tmp/whatever.wav' })).rejects.toThrow(/ELEVENLABS_API_KEY/);
  });
});
