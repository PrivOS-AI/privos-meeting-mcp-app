import { describe, expect, it } from 'vitest';

import { buildTranscriptMarkdown } from './markdown-writer.js';

describe('buildTranscriptMarkdown', () => {
  it('renders title, meta and one heading per segment', () => {
    const md = buildTranscriptMarkdown({
      title: 'Họp tuần',
      startedAt: '2026-09-18T01:00:00.000Z',
      durationSec: 62,
      languageCode: 'vi',
      provider: 'soniox-async',
      segments: [{ id: 'seg-0', speakerId: 'speaker_1', startSec: 0, endSec: 5, text: 'Xin chào mọi người', lang: 'vi', tokenCount: 3 }],
    });
    expect(md).toContain('# Họp tuần');
    expect(md).toContain('## [00:00:00] speaker_1');
    expect(md).toContain('Xin chào mọi người');
  });

  it('uses a resolved display name when provided, falling back to the raw speakerId otherwise', () => {
    const segments = [{ id: 'seg-0', speakerId: 'speaker_1', startSec: 65, endSec: 66, text: 'hi', lang: 'vi', tokenCount: 1 }];
    const withName = buildTranscriptMarkdown({
      title: 't', startedAt: 'x', durationSec: 0, languageCode: 'vi', provider: 'soniox-async',
      segments, displayNameBySpeaker: { speaker_1: 'Nam' },
    });
    expect(withName).toContain('## [00:01:05] Nam');

    const withoutName = buildTranscriptMarkdown({ title: 't', startedAt: 'x', durationSec: 0, languageCode: 'vi', provider: 'soniox-async', segments });
    expect(withoutName).toContain('## [00:01:05] speaker_1');
  });
});
