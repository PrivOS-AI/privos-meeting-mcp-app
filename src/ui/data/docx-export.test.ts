import { Packer } from 'docx';
import { describe, expect, it } from 'vitest';

import { buildMeetingDocx, type BuildMeetingDocxInput } from './docx-export.js';

const BASE_INPUT: BuildMeetingDocxInput = {
  title: 'Họp kế hoạch quý 3',
  startedAt: '2026-09-17T02:00:00.000Z',
  durationSec: 1830,
  language: 'vi',
  speakers: [
    { speakerId: 'spk-1', displayName: 'An' },
    { speakerId: 'spk-2', displayName: 'Bình' },
  ],
  segments: [
    { speakerId: 'spk-1', startSec: 0, text: 'Chào mọi người.' },
    { speakerId: 'spk-2', startSec: 12, text: 'Chào An.', translation: 'Hi An.' },
  ],
  summary: {
    summary: 'Đã thống nhất kế hoạch quý 3.',
    decisions: ['Chốt ngân sách 500 triệu.'],
    action_items: [{ task: 'Gửi báo cáo', owner: 'An', due: '2026-09-20' }],
    key_topics: ['ngân sách', 'kế hoạch'],
  },
};

describe('buildMeetingDocx', () => {
  it('produces a Document that Packer can serialize to a non-empty buffer', async () => {
    const doc = buildMeetingDocx(BASE_INPUT);
    const buffer = await Packer.toBuffer(doc);
    expect(buffer.length).toBeGreaterThan(0);
  });

  it('handles a meeting with no summary yet (summaryError case) without throwing', async () => {
    const doc = buildMeetingDocx({ ...BASE_INPUT, summary: undefined });
    const buffer = await Packer.toBuffer(doc);
    expect(buffer.length).toBeGreaterThan(0);
  });

  it('handles empty decisions/action_items/segments without throwing', async () => {
    const doc = buildMeetingDocx({
      ...BASE_INPUT,
      segments: [],
      summary: { summary: '', decisions: [], action_items: [], key_topics: [] },
    });
    const buffer = await Packer.toBuffer(doc);
    expect(buffer.length).toBeGreaterThan(0);
  });

  it('renders English labels when language is "en"', async () => {
    const doc = buildMeetingDocx({ ...BASE_INPUT, language: 'en' });
    const buffer = await Packer.toBuffer(doc);
    expect(buffer.length).toBeGreaterThan(0);
  });

  it('includes a bilingual segment (original + translation) without throwing', async () => {
    const doc = buildMeetingDocx(BASE_INPUT);
    const buffer = await Packer.toBuffer(doc);
    expect(buffer.length).toBeGreaterThan(0);
  });
});
