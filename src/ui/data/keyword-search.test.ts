import { describe, expect, it } from 'vitest';

import { foldDiacritics, searchMeetings, searchTranscript, type MeetingSearchRow, type TranscriptSegmentLike } from './keyword-search.js';

describe('foldDiacritics', () => {
  it('strips Vietnamese tone/vowel marks and folds đ/Đ', () => {
    expect(foldDiacritics('họp')).toBe('hop');
    expect(foldDiacritics('Đăng Ký')).toBe('Dang Ky');
  });
});

describe('searchTranscript', () => {
  const segments: TranscriptSegmentLike[] = [
    { id: 'seg-1', startSec: 10, text: 'Chúng ta cần họp lại vào tuần sau.' },
    { id: 'seg-2', startSec: 42, text: 'Không có gì liên quan ở đây.' },
    { id: 'seg-3', startSec: 90, text: 'họp họp họp — ba lần trong một câu.' },
  ];

  it('matches a plain-ASCII query against accented text ("hop" finds "họp")', () => {
    const hits = searchTranscript(segments, 'hop');
    expect(hits).toHaveLength(4); // 1 in seg-1, 3 in seg-3
    expect(hits[0]).toMatchObject({ segmentId: 'seg-1', startSec: 10, hit: 'họp' });
  });

  it('is case-insensitive', () => {
    expect(searchTranscript(segments, 'HOP')).toHaveLength(4);
  });

  it('finds every occurrence within a single segment', () => {
    const hits = searchTranscript(segments, 'họp').filter((h) => h.segmentId === 'seg-3');
    expect(hits).toHaveLength(3);
  });

  it('returns no hits for an empty/whitespace query', () => {
    expect(searchTranscript(segments, '')).toEqual([]);
    expect(searchTranscript(segments, '   ')).toEqual([]);
  });

  it('returns no hits when nothing matches', () => {
    expect(searchTranscript(segments, 'xyz-not-present')).toEqual([]);
  });

  it('captures surrounding context in pre/post', () => {
    const [hit] = searchTranscript(segments, 'liên quan');
    expect(hit.pre).toContain('Không có gì');
    expect(hit.post).toContain('đây');
  });
});

describe('searchMeetings', () => {
  const rows: MeetingSearchRow[] = [
    { id: 'm1', title: 'Họp kế hoạch quý 3', summaryText: 'Bàn về ngân sách.' },
    { id: 'm2', title: 'Standup hằng ngày', summaryText: 'Không có gì đặc biệt.' },
  ];

  it('matches title diacritic-insensitively', () => {
    expect(searchMeetings(rows, 'hop ke hoach').map((r) => r.id)).toEqual(['m1']);
  });

  it('matches summary text', () => {
    expect(searchMeetings(rows, 'ngan sach').map((r) => r.id)).toEqual(['m1']);
  });

  it('returns every row unfiltered for an empty query', () => {
    expect(searchMeetings(rows, '')).toEqual(rows);
  });

  it('returns an empty array when nothing matches', () => {
    expect(searchMeetings(rows, 'khong-ton-tai')).toEqual([]);
  });
});
