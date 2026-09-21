import { describe, expect, it } from 'vitest';

import { cosineSimilarity, decodeEmbedding, encodeEmbedding } from './cosine.js';

describe('cosineSimilarity', () => {
  it('is 1 for identical direction', () => {
    const a = new Float32Array([1, 2, 3]);
    const b = new Float32Array([2, 4, 6]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(1, 6);
  });

  it('is 0 for orthogonal vectors', () => {
    expect(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([0, 1]))).toBeCloseTo(0, 6);
  });

  it('is 0 when a vector has zero magnitude', () => {
    expect(cosineSimilarity(new Float32Array([0, 0]), new Float32Array([1, 1]))).toBe(0);
  });

  it('throws on length mismatch', () => {
    expect(() => cosineSimilarity(new Float32Array([1]), new Float32Array([1, 2]))).toThrow();
  });
});

describe('encode/decode embedding', () => {
  it('round-trips a Float32 vector', () => {
    const original = new Float32Array([0.125, -1.5, 3.25, 0]);
    const decoded = decodeEmbedding(encodeEmbedding(original));
    expect(Array.from(decoded)).toEqual(Array.from(original));
  });
});
