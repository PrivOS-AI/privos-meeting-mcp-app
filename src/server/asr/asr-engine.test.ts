import { describe, expect, it } from 'vitest';

import { pickLanguage, sentenceCase, tokensToWords } from './asr-engine.js';

describe('tokensToWords', () => {
  it('joins BPE pieces into words and offsets times onto the caller clock', () => {
    const words = tokensToWords([' NHỮNG', ' NƠI', ' KH', 'Ố', 'NG', ' CHẾ'], [0, 0.4, 1.24, 1.28, 1.32, 1.48], 10, 2.4);
    expect(words.map((w) => w.text)).toEqual([' NHỮNG', ' NƠI', ' KHỐNG', ' CHẾ']);
    expect(words.map((w) => [w.startSec, w.endSec])).toEqual([
      [10, 10.4],
      [10.4, 11.24],
      [11.24, 11.48],
      [11.48, 12.4],
    ]);
  });

  it('opens a word on the first token even without a leading space, and drops empty pieces', () => {
    expect(tokensToWords(['HELLO', ' ', ' WORLD'], [0, 0.5, 0.6], 0, 1).map((w) => w.text)).toEqual([' HELLO', ' WORLD']);
  });
});

describe('sentenceCase', () => {
  it('lower-cases model output and capitalises the first word (Vietnamese diacritics included)', () => {
    const words = sentenceCase(
      [
        { text: ' ÂM', startSec: 0, endSec: 1 },
        { text: ' LƯỢNG', startSec: 1, endSec: 2 },
        { text: ' TV', startSec: 2, endSec: 3 },
      ],
      'vi',
    );
    expect(words.map((w) => w.text).join('').trim()).toBe('Âm lượng tv');
  });
});

describe('pickLanguage', () => {
  it('picks the model whose output fits best (mean token log-prob)', () => {
    expect(pickLanguage({ meanLogProb: -0.005 }, { meanLogProb: -0.471 })).toBe('vi');
    expect(pickLanguage({ meanLogProb: -0.441 }, { meanLogProb: -0.158 })).toBe('en');
  });

  it('keeps a close call Vietnamese', () => {
    expect(pickLanguage({ meanLogProb: -0.2 }, { meanLogProb: -0.17 })).toBe('vi');
  });
});
