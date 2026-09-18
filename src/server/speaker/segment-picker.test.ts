import { describe, expect, it } from 'vitest';

import type { Segment } from '../transcript/segment-builder.js';
import { planEnrolment } from './segment-picker.js';

function seg(overrides: Partial<Segment> & Pick<Segment, 'speakerId' | 'startSec' | 'endSec'>): Segment {
  return {
    id: `seg-${overrides.startSec}`,
    text: overrides.text ?? 'xin chào mọi người hôm nay',
    lang: 'vi',
    tokenCount: 5,
    avgConfidence: 0.9,
    ...overrides,
  };
}

describe('planEnrolment', () => {
  it('picks the longest + most confident segments until targetSec, capped at 8 ranges', () => {
    const segments: Segment[] = Array.from({ length: 12 }, (_, i) =>
      seg({ speakerId: 'spk1', startSec: i * 10, endSec: i * 10 + 5, avgConfidence: 0.5 + i * 0.01 }),
    );
    const [plan] = planEnrolment(segments, { minSegSec: 2, targetSec: 25 });
    expect(plan.speakerId).toBe('spk1');
    expect(plan.ranges.length).toBeLessThanOrEqual(8);
    expect(plan.totalSec).toBeGreaterThanOrEqual(25);
  });

  it('skips a speaker whose picked segments are shorter than 2x minSegSec (too little clean data)', () => {
    const segments: Segment[] = [
      seg({ speakerId: 'spk1', startSec: 0, endSec: 2.5 }), // just clears minSegSec=2, but total < 4
    ];
    const [plan] = planEnrolment(segments, { minSegSec: 2, targetSec: 25 });
    expect(plan.ranges).toEqual([]);
    expect(plan.totalSec).toBe(0);
  });

  it('filters out segments with too few words even if long enough', () => {
    const segments: Segment[] = [
      seg({ speakerId: 'spk1', startSec: 0, endSec: 10, text: 'ừ' }),
      seg({ speakerId: 'spk1', startSec: 20, endSec: 40, text: 'đây là một câu nói đầy đủ có nhiều từ' }),
    ];
    const [plan] = planEnrolment(segments, { minSegSec: 2, targetSec: 15 });
    expect(plan.ranges).toEqual([{ startSec: 20, endSec: 40 }]);
  });

  it('handles many short segments across one long speaker (aggregate totalSpeakSec still reported)', () => {
    const segments: Segment[] = Array.from({ length: 5 }, (_, i) =>
      seg({ speakerId: 'spk1', startSec: i * 3, endSec: i * 3 + 1 }), // 1s each, below minSegSec=2
    );
    const [plan] = planEnrolment(segments, { minSegSec: 2, targetSec: 25 });
    expect(plan.ranges).toEqual([]);
    expect(plan.totalSpeakSec).toBeCloseTo(5, 5);
  });

  it('returns one plan per distinct speaker', () => {
    const segments: Segment[] = [
      seg({ speakerId: 'spk1', startSec: 0, endSec: 10 }),
      seg({ speakerId: 'spk2', startSec: 10, endSec: 20 }),
    ];
    const plans = planEnrolment(segments, { minSegSec: 2, targetSec: 25 });
    expect(plans.map((p) => p.speakerId).sort()).toEqual(['spk1', 'spk2']);
  });
});
