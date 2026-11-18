import { describe, expect, it } from 'vitest';

import { hotwordList, hotwordPhrase, MAX_HOTWORDS, tokenAlphabet } from './hotwords.js';

const LETTERS = ['P', 'R', 'I', 'V', 'O', 'S', 'H', 'À', 'N', 'Ộ', 'Q', 'U', 'Ỳ', 'A'];
const TOKENS = ['<blk> 0', '<sos/eos> 1', '<unk> 2', '▁PRI 3', '▁HÀ 4', 'ỲNH 5', '▁Z 6', ...LETTERS.map((l, i) => `${i % 2 ? '▁' : ''}${l} ${i + 7}`), ''].join('\n');
const alphabet = tokenAlphabet(TOKENS);

describe('hotwords', () => {
  it("reads the model's single-letter pieces from tokens.txt, without markers or special tokens", () => {
    expect([...alphabet].sort()).toEqual([...LETTERS, 'Z'].sort());
    // A letter found only inside a longer piece is not one the model can always spell.
    expect(tokenAlphabet(['▁ỲNH 0', 'N 1'].join('\n'))).toEqual(new Set(['N']));
  });

  it('writes a term as the model does: upper case, NFC, no punctuation', () => {
    expect(hotwordPhrase('PrivOS', alphabet, 'vi')).toBe('PRIVOS');
    expect(hotwordPhrase('  hà   nội, ', alphabet, 'vi')).toBe('HÀ NỘI');
    // Decomposed input (a Mac keyboard) still matches the model's composed letters.
    expect(hotwordPhrase('Quỳnh'.normalize('NFD'), alphabet, 'vi')).toBe('QUỲNH');
  });

  it('leaves out what the model cannot spell or what would bias too much', () => {
    expect(hotwordPhrase('Zalo', alphabet, 'vi')).toBe('');
    expect(hotwordPhrase('PrivOS 2', alphabet, 'vi')).toBe('');
    expect(hotwordPhrase('An', alphabet, 'vi')).toBe('');
    expect(hotwordPhrase('Hà Nội Hà Nội Hà Nội', alphabet, 'vi')).toBe('');
  });

  it('joins unique phrases with "/" and caps the list', () => {
    expect(hotwordList(['PrivOS', 'privos', 'Zalo', 'Hà Nội'], alphabet, 'vi')).toBe('PRIVOS/HÀ NỘI');
    expect(hotwordList([], alphabet, 'vi')).toBe('');
    const many = Array.from({ length: MAX_HOTWORDS + 20 }, (_, i) => 'PRIVOS ' + 'A'.repeat(i + 1)).map((t) => t.slice(0, 40));
    expect(hotwordList(many, alphabet, 'vi').split('/').length).toBeLessThanOrEqual(MAX_HOTWORDS);
  });
});
