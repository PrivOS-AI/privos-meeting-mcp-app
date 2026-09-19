import { describe, expect, it } from 'vitest';

import { extractWebmInitSegment } from './webm-init-segment.js';

const CLUSTER = Buffer.from([0x1f, 0x43, 0xb6, 0x75]);

describe('extractWebmInitSegment', () => {
  it('returns the bytes before the first Cluster (the header/init segment)', () => {
    const header = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x11, 0x22, 0x33]);
    const part0 = Buffer.concat([header, CLUSTER, Buffer.from([0xaa, 0xbb])]);
    expect(extractWebmInitSegment(part0).equals(header)).toBe(true);
  });

  it('stops at the FIRST Cluster even when several are present', () => {
    const header = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
    const part0 = Buffer.concat([header, CLUSTER, Buffer.from([0x01]), CLUSTER, Buffer.from([0x02])]);
    expect(extractWebmInitSegment(part0).equals(header)).toBe(true);
  });

  it('returns the whole buffer unchanged when no Cluster marker is present', () => {
    const bytes = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0x01]);
    expect(extractWebmInitSegment(bytes).equals(bytes)).toBe(true);
  });
});
