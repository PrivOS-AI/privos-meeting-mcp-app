import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { env } from '../env.js';
import { openEmbedding, resetVoiceprintKeyCacheForTests, sealEmbedding } from './voiceprint-crypto.js';

function setKey(key: Buffer | undefined): void {
  env.voiceprintEncKey = key?.toString('base64');
  resetVoiceprintKeyCacheForTests();
}

describe('voiceprint-crypto', () => {
  beforeEach(() => {
    setKey(randomBytes(32));
  });

  it('round-trips an embedding through seal -> open', () => {
    const vec = new Float32Array([0.1, -0.2, 0.3, 0.4, -0.5]);
    const sealed = sealEmbedding(vec, { profileId: 'profile-1', createdAt: '2026-09-18T00:00:00.000Z' });
    expect(sealed.profileId).toBe('profile-1');

    const opened = openEmbedding(sealed);
    expect(opened).not.toBeNull();
    expect(Array.from(opened!)).toEqual(Array.from(vec));
  });

  it('rejects a tampered ciphertext byte with hmac_mismatch (returns null, does not throw)', () => {
    const vec = new Float32Array([1, 2, 3]);
    const sealed = sealEmbedding(vec, { profileId: 'profile-1', createdAt: '2026-09-18T00:00:00.000Z' });
    const ctBytes = Buffer.from(sealed.ct, 'base64');
    ctBytes[0] ^= 0xff; // flip one byte
    const tampered = { ...sealed, ct: ctBytes.toString('base64') };

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(() => openEmbedding(tampered)).not.toThrow();
    expect(openEmbedding(tampered)).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('hmac_mismatch'), expect.objectContaining({ reason: 'hmac_mismatch' }));
    warnSpy.mockRestore();
  });

  it('rejects a record moved onto a different profileId (hmac covers profileId)', () => {
    const vec = new Float32Array([1, 2, 3]);
    const sealed = sealEmbedding(vec, { profileId: 'profile-1', createdAt: '2026-09-18T00:00:00.000Z' });
    const moved = { ...sealed, profileId: 'profile-2' };
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(openEmbedding(moved)).toBeNull();
  });

  it('returns null without throwing when VOICEPRINT_ENC_KEY is missing', () => {
    setKey(undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const sealedFromNowhere = { ct: 'AAAA', iv: 'AAAA', tag: 'AAAA', hmac: 'AAAA', profileId: 'p', createdAt: 'now' };
    expect(openEmbedding(sealedFromNowhere)).toBeNull();
    errorSpy.mockRestore();
  });

  it('still seals+opens with the built-in default key when none is configured', () => {
    setKey(undefined);
    const vec = new Float32Array([0.4, -0.1, 0.9]);
    const opened = openEmbedding(sealEmbedding(vec, { profileId: "p", createdAt: "now" }));
    expect(opened && Array.from(opened)).toEqual(Array.from(vec));
  });

  it('accepts a key of any length (derives 32 bytes) — not only 32-byte base64', () => {
    env.voiceprintEncKey = 'a short human passphrase';
    const vec = new Float32Array([1, 2, 3]);
    const opened = openEmbedding(sealEmbedding(vec, { profileId: "p", createdAt: "now" }));
    expect(opened && Array.from(opened)).toEqual(Array.from(vec));
  });
});
