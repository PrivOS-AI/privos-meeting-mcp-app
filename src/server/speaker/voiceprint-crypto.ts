/**
 * Voiceprint encryption boundary (QĐ-06). `db:*` scopes are granted to the
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
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

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
 * Lazily derives (and caches) the AES key + HMAC key from `VOICEPRINT_ENC_KEY`.
 * Re-derives if the env value ever changes within the process (tests swap it);
 * production reads it once at boot and never again. Throws a clear error when
 * the key is absent or not a 32-byte base64 value — callers must not silently
 * proceed with voiceprint operations when the key is missing.
 */
function keyMaterial(): { key: Buffer; macKey: Buffer } {
  const encKeyB64 = env.voiceprintEncKey;
  if (!encKeyB64) {
    throw new Error('VOICEPRINT_ENC_KEY chưa được cấu hình — không thể mã hoá/giải mã voiceprint.');
  }
  if (cachedKeyMaterial && cachedKeyMaterial.encKeyB64 === encKeyB64) {
    return cachedKeyMaterial;
  }
  const key = Buffer.from(encKeyB64, 'base64');
  if (key.length !== 32) {
    throw new Error(`VOICEPRINT_ENC_KEY phải là 32 byte base64 (đọc được ${key.length} byte).`);
  }
  const macKey = Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), HKDF_INFO, HKDF_HASH_BYTES));
  cachedKeyMaterial = { encKeyB64, key, macKey };
  return cachedKeyMaterial;
}

/** Test-only: force key material to be re-derived on the next call. */
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
 * Opens a sealed embedding. Returns `null` (never throws) on ANY integrity or
 * format failure — HMAC mismatch, corrupt base64, wrong IV/tag length, GCM
 * auth failure — logging a reason so an operator can spot tampering without
 * this ever crashing a match/enrol pass for the workspace's other profiles.
 */
export function openEmbedding(sealed: SealedEmbedding): Float32Array | null {
  let key: Buffer;
  let macKey: Buffer;
  try {
    ({ key, macKey } = keyMaterial());
  } catch (error) {
    console.error('[voiceprint-crypto] thiếu/hỏng VOICEPRINT_ENC_KEY:', error instanceof Error ? error.message : error);
    return null;
  }

  try {
    const ct = Buffer.from(sealed.ct, 'base64');
    const iv = Buffer.from(sealed.iv, 'base64');
    const tag = Buffer.from(sealed.tag, 'base64');
    const hmac = Buffer.from(sealed.hmac, 'base64');
    if (iv.length !== IV_BYTES || tag.length !== 16 || hmac.length !== 32) {
      console.warn('[voiceprint-crypto] sealed embedding có kích thước trường không hợp lệ, bỏ qua.', { profileId: sealed.profileId });
      return null;
    }

    const expectedHmac = computeHmac(macKey, sealed.profileId, ct, sealed.createdAt);
    if (expectedHmac.length !== hmac.length || !timingSafeEqual(expectedHmac, hmac)) {
      console.warn('[voiceprint-crypto] hmac_mismatch — bỏ qua bản ghi (có thể bị sửa/giả mạo).', { profileId: sealed.profileId, reason: 'hmac_mismatch' });
      return null;
    }

    const decipher = createDecipheriv(AES_ALGO, key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
    const usable = plain.byteLength & ~3;
    return new Float32Array(plain.buffer.slice(plain.byteOffset, plain.byteOffset + usable));
  } catch (error) {
    console.warn('[voiceprint-crypto] giải mã thất bại, bỏ qua bản ghi.', { profileId: sealed.profileId, error: error instanceof Error ? error.message : String(error) });
    return null;
  }
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
