/**
 * Voiceprint encryption boundary (D-06). `db:*` scopes are granted to the
 * iframe on the SAME namespace as the backend (bot credential), so "the
 * vector never leaves the backend" cannot be enforced by a tool boundary
 * alone — the iframe can `mcpapp.db.query` `speaker_profiles` directly. This
 * module is what actually enforces it: every embedding is sealed with
 * AES-256-GCM + a detached HMAC-SHA256 before it is ever written to App DB,
 * so a raw read from the iframe only ever sees ciphertext.
 *
 * The HMAC key is derived from `VOICEPRINT_ENC_KEY` via HKDF (not the same
 * bytes as the AES key) and covers `{profileId, ct, createdAt}` — a byte
 * flipped in `ct` (or a record copied onto a different profile) fails the
 * HMAC check. `openEmbedding` verifies the HMAC with `timingSafeEqual`
 * BEFORE attempting to decrypt, and NEVER throws: a mismatch is a corrupted
 * or tampered record, not a bug in the caller, so it resolves to `null` and
 * logs `{ profileId, reason: 'hmac_mismatch' }` — matching continues with
 * whatever other embeddings are still valid.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

import { env } from '../env.js';

export interface SealedEmbedding {
  /** Ciphertext, base64. */
  ct: string;
  /** AES-GCM IV, base64. */
  iv: string;
  /** AES-GCM auth tag, base64. */
  tag: string;
  /** HMAC-SHA256 over `{profileId, ct, createdAt}`, base64. */
  hmac: string;
  profileId: string;
  createdAt: string;
}

const AES_ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const HKDF_INFO = 'meeting-agent/voiceprint-hmac';
const HKDF_HASH_BYTES = 32;

let cachedKeyMaterial: { encKeyB64: string; key: Buffer; macKey: Buffer } | undefined;

/**
 * A fixed PrivOS default so voiceprints work with zero configuration. It is
 * PUBLIC (it ships in the source), so it provides obfuscation, not real secrecy
 * — set `VOICEPRINT_ENC_KEY` to your own secret for genuine protection.
 */
const DEFAULT_VOICEPRINT_KEY = 'privos:meeting-agent:voiceprint:v1:default';

/**
 * Lazily derives (and caches) the AES key + HMAC key from `VOICEPRINT_ENC_KEY`.
 * AES-256 needs EXACTLY 32 bytes (a crypto requirement, not our own rule), so
 * we accept a key of any length — or none — and derive the 32 bytes via SHA-256,
 * falling back to {@link DEFAULT_VOICEPRINT_KEY} when unset. Re-derives if the
 * configured value changes within the process (tests swap it).
 */
function keyMaterial(): { key: Buffer; macKey: Buffer } {
  const source = env.voiceprintEncKey?.trim() || DEFAULT_VOICEPRINT_KEY;
  if (cachedKeyMaterial && cachedKeyMaterial.encKeyB64 === source) {
    return cachedKeyMaterial;
  }
  const key = createHash('sha256').update(source, 'utf8').digest();
  const macKey = Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), HKDF_INFO, HKDF_HASH_BYTES));
  cachedKeyMaterial = { encKeyB64: source, key, macKey };
  return cachedKeyMaterial;
}

export function resetVoiceprintKeyCacheForTests(): void {
  cachedKeyMaterial = undefined;
}

function computeHmac(macKey: Buffer, profileId: string, ct: Buffer, createdAt: string): Buffer {
  return createHmac('sha256', macKey).update(profileId).update(ct).update(createdAt).digest();
}

/** Seals a Float32 embedding for storage — the ONLY way an embedding should ever be written to App DB. */
export function sealEmbedding(vec: Float32Array, meta: { profileId: string; createdAt: string }): SealedEmbedding {
  const { key, macKey } = keyMaterial();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(AES_ALGO, key, iv);
  const plain = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  const hmac = computeHmac(macKey, meta.profileId, ct, meta.createdAt);
  return {
    ct: ct.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    hmac: hmac.toString('base64'),
    profileId: meta.profileId,
    createdAt: meta.createdAt,
  };
}

/**
 * Verifies + decrypts a sealed envelope down to its raw plaintext buffer.
 * Shared by `openEmbedding` (plaintext = the vector's own bytes) and
 * `openEmbeddingWithMeta` (plaintext = a length-prefixed JSON meta blob
 * followed by the vector's bytes) so the HMAC/AES-GCM verification logic
 * lives in exactly one place. Returns `null` (never throws) on ANY integrity
 * or format failure — HMAC mismatch, corrupt base64, wrong IV/tag length, GCM
 * auth failure — logging a reason so an operator can spot tampering without
 * this ever crashing a match/enrol pass for the workspace's other profiles.
 */
function verifyAndDecrypt(sealed: SealedEmbedding): Buffer | null {
  let key: Buffer;
  let macKey: Buffer;
  try {
    ({ key, macKey } = keyMaterial());
  } catch (error) {
    console.error('[voiceprint-crypto] missing/corrupt VOICEPRINT_ENC_KEY:', error instanceof Error ? error.message : error);
    return null;
  }

  try {
    const ct = Buffer.from(sealed.ct, 'base64');
    const iv = Buffer.from(sealed.iv, 'base64');
    const tag = Buffer.from(sealed.tag, 'base64');
    const hmac = Buffer.from(sealed.hmac, 'base64');
    if (iv.length !== IV_BYTES || tag.length !== 16 || hmac.length !== 32) {
      console.warn('[voiceprint-crypto] sealed embedding has an invalid field size, skipping.', { profileId: sealed.profileId });
      return null;
    }

    const expectedHmac = computeHmac(macKey, sealed.profileId, ct, sealed.createdAt);
    if (expectedHmac.length !== hmac.length || !timingSafeEqual(expectedHmac, hmac)) {
      console.warn('[voiceprint-crypto] hmac_mismatch — skipping record (may be tampered/forged).', { profileId: sealed.profileId, reason: 'hmac_mismatch' });
      return null;
    }

    const decipher = createDecipheriv(AES_ALGO, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch (error) {
    console.warn('[voiceprint-crypto] decryption failed, skipping record.', { profileId: sealed.profileId, error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

/**
 * Opens a sealed embedding. Returns `null` (never throws) on ANY integrity or
 * format failure — see {@link verifyAndDecrypt}.
 */
export function openEmbedding(sealed: SealedEmbedding): Float32Array | null {
  const plain = verifyAndDecrypt(sealed);
  if (!plain) return null;
  const usable = plain.byteLength & ~3;
  return new Float32Array(plain.buffer.slice(plain.byteOffset, plain.byteOffset + usable));
}

/**
 * Seals a vector TOGETHER WITH small JSON-serializable metadata inside the
 * SAME encrypted payload — the AES-GCM auth tag (verified by
 * {@link verifyAndDecrypt} before any byte is trusted) then covers the meta
 * too, unlike a plain sibling JSON field sitting outside `ct`. Used for the
 * live/pending voiceprint envelopes, whose coherence metadata must not be
 * forgeable by a direct App DB write (the iframe shares the bot's `db:*`
 * scope — see file header). Plaintext layout: 4-byte little-endian length
 * prefix + UTF-8 JSON meta + raw Float32 vector bytes.
 */
export function sealEmbeddingWithMeta<M>(vec: Float32Array, meta: { profileId: string; createdAt: string }, extra: M): SealedEmbedding {
  const { key, macKey } = keyMaterial();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(AES_ALGO, key, iv);
  const metaJson = Buffer.from(JSON.stringify(extra), 'utf8');
  const lenPrefix = Buffer.alloc(4);
  lenPrefix.writeUInt32LE(metaJson.length, 0);
  const vecBuf = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
  const plain = Buffer.concat([lenPrefix, metaJson, vecBuf]);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  const hmac = computeHmac(macKey, meta.profileId, ct, meta.createdAt);
  return {
    ct: ct.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    hmac: hmac.toString('base64'),
    profileId: meta.profileId,
    createdAt: meta.createdAt,
  };
}

/**
 * Opens an envelope sealed by {@link sealEmbeddingWithMeta}, additionally
 * asserting the embedded `profileId` equals `expectedProfileId` — binds a
 * sealed row to the exact `meeting_speakers` row it was read from, so a copy
 * of one row's `pendingEmbedding` string onto another row is rejected even
 * though the HMAC itself still verifies (the HMAC alone cannot know which
 * row a JSON string is currently sitting on in App DB). Returns `null`
 * (never throws) on a binding mismatch, integrity failure, or malformed
 * plaintext layout (e.g. an OLD-shape envelope sealed by plain
 * `sealEmbedding`, which has no length-prefixed meta at all).
 */
export function openEmbeddingWithMeta<M>(sealed: SealedEmbedding, expectedProfileId: string): { vector: Float32Array; meta: M } | null {
  if (sealed.profileId !== expectedProfileId) {
    console.warn('[voiceprint-crypto] profile_id_mismatch — envelope does not belong to the row it was read from, rejecting.', {
      expected: expectedProfileId,
      actual: sealed.profileId,
    });
    return null;
  }
  const plain = verifyAndDecrypt(sealed);
  if (!plain || plain.length < 4) return null;
  const metaLen = plain.readUInt32LE(0);
  if (metaLen < 0 || 4 + metaLen > plain.length) return null;
  let meta: M;
  try {
    meta = JSON.parse(plain.subarray(4, 4 + metaLen).toString('utf8')) as M;
  } catch {
    return null;
  }
  const vecBuf = plain.subarray(4 + metaLen);
  const usable = vecBuf.byteLength & ~3;
  const vector = new Float32Array(vecBuf.buffer.slice(vecBuf.byteOffset, vecBuf.byteOffset + usable));
  return { vector, meta };
}

/** Type guard + shape check for a value read back as JSON from App DB. */
export function isSealedEmbedding(value: unknown): value is SealedEmbedding {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.ct === 'string' &&
    typeof v.iv === 'string' &&
    typeof v.tag === 'string' &&
    typeof v.hmac === 'string' &&
    typeof v.profileId === 'string' &&
    typeof v.createdAt === 'string'
  );
}

/** Parses one `embeddings[]` JSON-string element into a `SealedEmbedding`, or `null` on malformed JSON/shape. */
export function parseSealedEmbedding(json: string): SealedEmbedding | null {
  try {
    const parsed: unknown = JSON.parse(json);
    return isSealedEmbedding(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
