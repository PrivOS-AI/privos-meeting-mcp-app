import { describe, expect, it } from 'vitest';

import { folderName, isoDate, meetingId8, partFileName, slugify } from './meeting-slug.js';

describe('slugify', () => {
  it('strips Vietnamese diacritics and lowercases', () => {
    expect(slugify('Họp Kế hoạch Quý 4')).toBe('hop-ke-hoach-quy-4');
  });

  it('collapses symbols and trims dashes', () => {
    expect(slugify('  Sprint #12 — Review!! ')).toBe('sprint-12-review');
  });

  it('falls back to "meeting" for an empty or symbol-only title', () => {
    expect(slugify('')).toBe('meeting');
    expect(slugify('!!!')).toBe('meeting');
  });
});

describe('folder and part naming carry the meetingId8 collision guard', () => {
  it('embeds date, slug and 8-char id in the folder', () => {
    const date = new Date('2026-09-17T08:00:00Z');
    expect(folderName('Họp nhóm', 'abcdef1234567890', date)).toBe('Meetings/2026-09-17-hop-nhom-abcdef12');
  });

  it('embeds a zero-padded seq and the meetingId8 in a part name', () => {
    expect(partFileName(7, 'abcdef1234567890')).toBe('audio.part-0007-abcdef12.webm');
  });

  it('meetingId8 strips non-alphanumerics (and only falls back when empty)', () => {
    expect(meetingId8('ab-cd')).toBe('abcd');
    expect(isoDate(new Date('2026-01-02T00:00:00Z'))).toBe('2026-01-02');
  });
});
