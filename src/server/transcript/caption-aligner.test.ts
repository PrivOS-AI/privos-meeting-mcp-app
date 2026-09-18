import { describe, expect, it } from 'vitest';

import { alignByMaxOverlap } from './caption-aligner.js';

interface NamedSpan {
  id: string;
  startMs: number;
  endMs: number;
}

describe('alignByMaxOverlap', () => {
  it('maps a partial overlap', () => {
    const a: NamedSpan[] = [{ id: 'a1', startMs: 0, endMs: 1000 }];
    const b: NamedSpan[] = [{ id: 'b1', startMs: 500, endMs: 1500 }];
    const [result] = alignByMaxOverlap(a, b);
    expect(result.b?.id).toBe('b1');
  });

  it('maps a span fully contained within another (longer overlap wins)', () => {
    const a: NamedSpan[] = [{ id: 'a1', startMs: 100, endMs: 200 }];
    const b: NamedSpan[] = [
      { id: 'b1', startMs: 0, endMs: 1000 },
      { id: 'b2', startMs: 150, endMs: 160 },
    ];
    const [result] = alignByMaxOverlap(a, b);
    expect(result.b?.id).toBe('b1');
  });

  it('a tie in overlap is won by the longer span', () => {
    const a: NamedSpan[] = [{ id: 'a1', startMs: 0, endMs: 1000 }];
    const b: NamedSpan[] = [
      { id: 'short', startMs: 0, endMs: 1000 },
      { id: 'long', startMs: -500, endMs: 1500 },
    ];
    const [result] = alignByMaxOverlap(a, b, { toleranceMs: 0 });
    expect(result.b?.id).toBe('long');
  });

  it('leaves unmapped when nothing overlaps within tolerance', () => {
    const a: NamedSpan[] = [{ id: 'a1', startMs: 0, endMs: 1000 }];
    const b: NamedSpan[] = [{ id: 'far', startMs: 5000, endMs: 6000 }];
    const [result] = alignByMaxOverlap(a, b, { toleranceMs: 100 });
    expect(result.b).toBeUndefined();
  });

  it('applies skewMs before comparing', () => {
    const a: NamedSpan[] = [{ id: 'a1', startMs: 1000, endMs: 2000 }];
    const b: NamedSpan[] = [{ id: 'b1', startMs: 0, endMs: 800 }]; // 200ms gap — beyond a 100ms tolerance

    const noSkew = alignByMaxOverlap(a, b, { toleranceMs: 100 });
    expect(noSkew[0].b).toBeUndefined();

    const withSkew = alignByMaxOverlap(a, b, { toleranceMs: 100, skewMs: 1000 });
    expect(withSkew[0].b?.id).toBe('b1');
  });
});
