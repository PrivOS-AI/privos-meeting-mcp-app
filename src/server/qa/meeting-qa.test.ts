import { describe, expect, it } from 'vitest';

import { answerHash, issueSaveToken, parseAskReply, qaMarker, renderQaEntry, selectContext, verifySaveToken, type QaLine } from './meeting-qa.js';

const lines: QaLine[] = [
  { id: 'L1', atSec: 0, speaker: 'Ngân', text: 'Chào mọi người, hôm nay mình chốt lịch phát hành.' },
  { id: 'L2', atSec: 65, speaker: 'Quỳnh', text: 'Mình sẽ đo RAM với bốn cuộc họp song song.' },
  { id: 'L3', atSec: 130, speaker: 'Ngân', text: 'Vậy phát hành vào thứ Sáu nhé.' },
];

describe('parseAskReply', () => {
  it('keeps only citations that are lines it was given, and takes quote/speaker/time from those lines', () => {
    const reply = '```json\n{"answer":"Phát hành thứ Sáu, do Ngân chốt.","citations":["L3","L99","L3"],"insufficient":false}\n```';
    expect(parseAskReply(reply, lines)).toEqual({
      answer: 'Phát hành thứ Sáu, do Ngân chốt.',
      citations: [{ lineId: 'L3', atSec: 130, speaker: 'Ngân', quote: 'Vậy phát hành vào thứ Sáu nhé.' }],
      insufficient: false,
    });
  });

  it('returns null for a reply that is not the JSON asked for', () => {
    expect(parseAskReply('Phát hành thứ Sáu.', lines)).toBeNull();
    expect(parseAskReply('{"citations": []}', lines)).toBeNull();
  });
});

describe('selectContext', () => {
  it('sends a short transcript whole', () => {
    expect(selectContext(lines, 'bao giờ phát hành?')).toEqual(lines);
  });

  it('narrows a long transcript to matching lines and their neighbours, in order, ignoring diacritics', () => {
    const long: QaLine[] = Array.from({ length: 400 }, (_, i) => ({ id: `L${i + 1}`, atSec: i * 10, speaker: 'A', text: `Câu nói không liên quan số ${i} ${'x'.repeat(80)}` }));
    long[200] = { id: 'L201', atSec: 2000, speaker: 'Ngân', text: 'Ngân chịu trách nhiệm báo giá cho khách.' };
    const picked = selectContext(long, 'ai lam bao gia?', 2_000);
    expect(picked.map((l) => l.id)).toContain('L201');
    expect(picked.map((l) => l.id)).toEqual(['L199', 'L200', 'L201', 'L202', 'L203']);
  });

  it('falls back to the most recent lines when nothing matches', () => {
    const long: QaLine[] = Array.from({ length: 300 }, (_, i) => ({ id: `L${i + 1}`, atSec: i, speaker: 'A', text: 'y'.repeat(100) }));
    const picked = selectContext(long, 'zzz', 1_000);
    expect(picked.at(-1)?.id).toBe('L300');
    expect(picked.length).toBeGreaterThan(0);
  });
});

describe('save token', () => {
  const answer = { answer: 'Thứ Sáu.', citations: [{ lineId: 'L3', atSec: 130, speaker: 'Ngân', quote: 'Vậy phát hành vào thứ Sáu nhé.' }], insufficient: false };
  const binding = { userId: 'u1', roomId: 'r1', meetingId: 'm1', hash: answerHash('Khi nào phát hành?', answer) };

  it('accepts the exact answer it was issued for', () => {
    expect(verifySaveToken(issueSaveToken(binding), binding)).toBe(true);
  });

  it('rejects a changed answer, another person, another meeting, an expired or forged token', () => {
    const token = issueSaveToken(binding);
    expect(verifySaveToken(token, { ...binding, hash: answerHash('Khi nào phát hành?', { ...answer, answer: 'Thứ Hai.' }) })).toBe(false);
    expect(verifySaveToken(token, { ...binding, userId: 'u2' })).toBe(false);
    expect(verifySaveToken(token, { ...binding, meetingId: 'm2' })).toBe(false);
    expect(verifySaveToken(issueSaveToken(binding, Date.now() - 60 * 60_000), binding)).toBe(false);
    expect(verifySaveToken(`${token.split('.')[0]}.forged`, binding)).toBe(false);
  });

  it('renders a qa.md entry with its citations and the marker that makes re-saving a no-op', () => {
    const entry = renderQaEntry({ question: 'Khi nào phát hành?', answer, hash: binding.hash, askedAtIso: '2026-10-28T03:15:00.000Z' });
    expect(entry).toContain('## Khi nào phát hành?');
    expect(entry).toContain('- [00:02:10] Ngân: “Vậy phát hành vào thứ Sáu nhé.”');
    expect(entry).toContain(qaMarker(binding.hash));
  });
});
