/**
 * CRUD over the GLOBAL `speaker_profiles` collection (App DB `scope:'global'`,
 * addressed room-lessly per QĐ-05 — never construct `AppDbBotClient` with a
 * `roomId` for this collection). Every embedding/centroid round-trips through
 * `voiceprint-crypto.ts` — this module never holds a plaintext vector longer
 * than the current call, and never writes one anywhere except inside a sealed
 * JSON string.
 *
 * `withProfileLock` + the re-read-before-write pattern in `enrolEmbedding`
 * guard against two concurrent jobs (e.g. two meetings processed back to
 * back) clobbering each other's `embeddings[]` — the lock only helps within
 * ONE process (this app runs as a single pm2 instance, `MEETING_JOB_CONCURRENCY`
 * defaults to 1), so it is a correctness net for same-process races, not a
 * distributed lock.
 */
import { AppDbBotClient, extractDbRecords, type DbRow } from '../hub/app-db-bot-client.js';
import { openEmbedding, parseSealedEmbedding, sealEmbedding, type SealedEmbedding } from './voiceprint-crypto.js';

export const EMBEDDING_CAP = 20;
const COLLECTION = 'speaker_profiles';
const SCOPE = 'global' as const;

export interface StoredEmbedding {
  vector: Float32Array;
  meetingId: string;
  durationSec: number;
  createdAt: string;
}

export interface SpeakerProfile {
  id: string;
  displayName: string;
  privosUserId?: string;
  privosUsername?: string;
  colorKey: string;
  createdByUserId: string;
  createdInRoomId?: string;
  embeddings: StoredEmbedding[];
  centroid: Float32Array | null;
  dim: number;
  sampleCount: number;
  lastSeenAt?: string;
}

export interface CreateProfileInput {
  displayName: string;
  createdByUserId: string;
  createdInRoomId?: string;
  privosUserId?: string;
  privosUsername?: string;
  colorKey?: string;
}

const COLOR_PALETTE = ['blue', 'gold', 'green', 'purple', 'coral', 'teal'] as const;

function normalizedName(displayName: string): string {
  return displayName.trim().toLowerCase();
}

function pickColorKey(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return COLOR_PALETTE[hash % COLOR_PALETTE.length];
}

/** Sealed-embedding element -> `StoredEmbedding`, or `null` when JSON parse/HMAC/decrypt fails (never throws — see `voiceprint-crypto.openEmbedding`). */
function openStoredEmbedding(json: string): StoredEmbedding | null {
  const sealed = parseSealedEmbedding(json);
  if (!sealed) return null;
  const vector = openEmbedding(sealed);
  if (!vector) return null;
  return { vector, meetingId: '', durationSec: 0, createdAt: sealed.createdAt };
}

/**
 * `embeddings[]` elements carry `{meetingId, durationSec}` OUTSIDE the sealed
 * envelope's own fields (those are `profileId`/`createdAt` only) — stored as
 * sibling JSON keys on the same string so `sealEmbedding`'s shape stays
 * generic (reused for `centroid` and `pendingEmbedding`, neither of which has
 * a `meetingId`/`durationSec`).
 */
interface StoredEmbeddingEnvelope extends SealedEmbedding {
  meetingId: string;
  durationSec: number;
}

function sealStoredEmbedding(vector: Float32Array, meta: { profileId: string; meetingId: string; durationSec: number; createdAt: string }): string {
  const sealed = sealEmbedding(vector, { profileId: meta.profileId, createdAt: meta.createdAt });
  const envelope: StoredEmbeddingEnvelope = { ...sealed, meetingId: meta.meetingId, durationSec: meta.durationSec };
  return JSON.stringify(envelope);
}

function openStoredEmbeddingEnvelope(json: string): StoredEmbedding | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const envelope = parsed as Partial<StoredEmbeddingEnvelope>;
  if (typeof envelope.ct !== 'string' || typeof envelope.profileId !== 'string' || typeof envelope.createdAt !== 'string') return null;
  const vector = openEmbedding(envelope as SealedEmbedding);
  if (!vector) return null;
  return {
    vector,
    meetingId: typeof envelope.meetingId === 'string' ? envelope.meetingId : '',
    durationSec: typeof envelope.durationSec === 'number' ? envelope.durationSec : 0,
    createdAt: envelope.createdAt,
  };
}

function rowToProfile(row: DbRow): SpeakerProfile {
  const embeddingsRaw = Array.isArray(row.embeddings) ? (row.embeddings as unknown[]) : [];
  const embeddings = embeddingsRaw
    .filter((e): e is string => typeof e === 'string')
    .map(openStoredEmbeddingEnvelope)
    .filter((e): e is StoredEmbedding => e !== null);

  const centroidJson = typeof row.centroid === 'string' && row.centroid ? row.centroid : null;
  const centroid = centroidJson ? openStoredEmbedding(centroidJson)?.vector ?? null : null;

  return {
    id: row._id,
    displayName: typeof row.displayName === 'string' ? row.displayName : '',
    privosUserId: typeof row.privosUserId === 'string' && row.privosUserId ? row.privosUserId : undefined,
    privosUsername: typeof row.privosUsername === 'string' && row.privosUsername ? row.privosUsername : undefined,
    colorKey: typeof row.colorKey === 'string' && row.colorKey ? row.colorKey : 'blue',
    createdByUserId: typeof row.createdByUserId === 'string' ? row.createdByUserId : '',
    createdInRoomId: typeof row.createdInRoomId === 'string' && row.createdInRoomId ? row.createdInRoomId : undefined,
    embeddings,
    centroid,
    dim: typeof row.dim === 'number' ? row.dim : (embeddings[0]?.vector.length ?? 0),
    sampleCount: typeof row.sampleCount === 'number' ? row.sampleCount : embeddings.length,
    lastSeenAt: typeof row.lastSeenAt === 'string' && row.lastSeenAt ? row.lastSeenAt : undefined,
  };
}

/** Every profile in the workspace, decoded — HMAC-invalid embeddings are silently dropped per profile (they never block a match against the profile's OTHER embeddings). */
export async function listProfiles(db: AppDbBotClient): Promise<SpeakerProfile[]> {
  const result = await db.query(COLLECTION, SCOPE, { limit: 1000 });
  return extractDbRecords(result).map(rowToProfile);
}

export async function getProfile(db: AppDbBotClient, profileId: string): Promise<SpeakerProfile | null> {
  const row = await db.getById(COLLECTION, SCOPE, profileId);
  return row ? rowToProfile(row) : null;
}

/** Finds an existing profile by case-insensitive display name — used by `speaker_resolve`'s `mode:'name'` to avoid creating duplicate profiles for the same typed name. */
export async function findProfileByName(db: AppDbBotClient, displayName: string): Promise<SpeakerProfile | null> {
  const result = await db.query(COLLECTION, SCOPE, {
    where: [{ field: 'displayNameNormalized', op: '==', value: normalizedName(displayName) }],
    limit: 1,
  });
  const row = extractDbRecords(result)[0];
  return row ? rowToProfile(row) : null;
}

export async function findProfileByPrivosUserId(db: AppDbBotClient, privosUserId: string): Promise<SpeakerProfile | null> {
  const result = await db.query(COLLECTION, SCOPE, {
    where: [{ field: 'privosUserId', op: '==', value: privosUserId }],
    limit: 1,
  });
  const row = extractDbRecords(result)[0];
  return row ? rowToProfile(row) : null;
}

export async function createProfile(db: AppDbBotClient, input: CreateProfileInput): Promise<SpeakerProfile> {
  const data: Record<string, unknown> = {
    displayName: input.displayName,
    displayNameNormalized: normalizedName(input.displayName),
    createdByUserId: input.createdByUserId,
    colorKey: input.colorKey ?? pickColorKey(input.displayName),
    embeddings: [],
    centroid: '',
    dim: 0,
    sampleCount: 0,
  };
  if (input.createdInRoomId) data.createdInRoomId = input.createdInRoomId;
  if (input.privosUserId) data.privosUserId = input.privosUserId;
  if (input.privosUsername) data.privosUsername = input.privosUsername;
  const row = await db.create(COLLECTION, SCOPE, data);
  return rowToProfile(row as DbRow);
}

// ---- in-process mutex (see file header — single-process guard only) ----
const locks = new Map<string, Promise<unknown>>();

export async function withProfileLock<T>(profileId: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(profileId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  locks.set(
    profileId,
    previous.then(() => gate),
  );
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(profileId) === previous.then(() => gate)) locks.delete(profileId);
  }
}

function computeCentroid(vectors: readonly Float32Array[]): Float32Array | null {
  if (vectors.length === 0) return null;
  const dim = vectors[0].length;
  const matching = vectors.filter((v) => v.length === dim);
  if (matching.length === 0) return null;
  const centroid = new Float32Array(dim);
  for (const v of matching) {
    for (let i = 0; i < dim; i++) centroid[i] += v[i];
  }
  for (let i = 0; i < dim; i++) centroid[i] /= matching.length;
  return centroid;
}

export interface EnrolInput {
  vector: Float32Array;
  meetingId: string;
  durationSec: number;
}

/**
 * Seals + appends one embedding to a profile: re-reads the row (under the
 * in-process lock) immediately before writing, caps to the `EMBEDDING_CAP`
 * MOST RECENT embeddings, recomputes `centroid`, bumps `sampleCount`/
 * `lastSeenAt`. `dim` is taken from the incoming vector — a model swap that
 * changes dimensionality naturally "wins" going forward; `speaker-matcher.ts`
 * already skips stored embeddings whose length differs from the query vector.
 */
export async function enrolEmbedding(db: AppDbBotClient, profileId: string, input: EnrolInput): Promise<void> {
  await withProfileLock(profileId, async () => {
    const row = await db.getById(COLLECTION, SCOPE, profileId);
    if (!row) throw new Error(`enrolEmbedding: profile ${profileId} không còn tồn tại.`);
    const current = rowToProfile(row);
    const createdAt = new Date().toISOString();

    const nextEmbeddings = [...current.embeddings, { vector: input.vector, meetingId: input.meetingId, durationSec: input.durationSec, createdAt }].slice(
      -EMBEDDING_CAP,
    );
    const centroid = computeCentroid(nextEmbeddings.map((e) => e.vector));

    const embeddingsJson = nextEmbeddings.map((e) =>
      sealStoredEmbedding(e.vector, { profileId, meetingId: e.meetingId, durationSec: e.durationSec, createdAt: e.createdAt }),
    );
    const centroidJson = centroid ? JSON.stringify(sealEmbedding(centroid, { profileId, createdAt })) : '';

    await db.update(COLLECTION, SCOPE, profileId, {
      embeddings: embeddingsJson,
      centroid: centroidJson,
      dim: input.vector.length,
      sampleCount: nextEmbeddings.length,
      lastSeenAt: createdAt,
    });
  });
}

/** Back-propagation for `meeting_relabel_speaker` — drops every embedding this profile got FROM the given meeting, then recomputes `centroid`/`sampleCount`. A no-op (not an error) when the profile has none from that meeting. */
export async function removeEmbeddingsOfMeeting(db: AppDbBotClient, profileId: string, meetingId: string): Promise<void> {
  await withProfileLock(profileId, async () => {
    const row = await db.getById(COLLECTION, SCOPE, profileId);
    if (!row) return;
    const current = rowToProfile(row);
    const remaining = current.embeddings.filter((e) => e.meetingId !== meetingId);
    if (remaining.length === current.embeddings.length) return;

    const createdAt = new Date().toISOString();
    const centroid = computeCentroid(remaining.map((e) => e.vector));
    const embeddingsJson = remaining.map((e) => sealStoredEmbedding(e.vector, { profileId, meetingId: e.meetingId, durationSec: e.durationSec, createdAt: e.createdAt }));
    const centroidJson = centroid ? JSON.stringify(sealEmbedding(centroid, { profileId, createdAt })) : '';

    await db.update(COLLECTION, SCOPE, profileId, {
      embeddings: embeddingsJson,
      centroid: centroidJson,
      sampleCount: remaining.length,
    });
  });
}

export async function renameProfile(db: AppDbBotClient, profileId: string, displayName: string): Promise<void> {
  await db.update(COLLECTION, SCOPE, profileId, { displayName, displayNameNormalized: normalizedName(displayName) });
}

export async function linkPrivosUser(db: AppDbBotClient, profileId: string, privosUserId: string, privosUsername?: string): Promise<void> {
  await db.update(COLLECTION, SCOPE, profileId, { privosUserId, privosUsername: privosUsername ?? '' });
}

/**
 * Deletes the profile AND every trace of it: `embeddings`/`centroid` die with
 * the row itself, then every `knownRooms` room is swept for `meeting_speakers`
 * rows pointing at this `profileId` — their `profileId` and `pendingEmbedding`
 * are cleared (the meeting keeps its `displayName` as a historical label, it
 * just stops being biometrically linked). Best-effort per room: one room's
 * query failing does not abort the rest — this is a deletion, it must make as
 * much forward progress as possible rather than leave a partial, retryable
 * state that still exposes biometric data.
 */
export async function deleteProfile(db: AppDbBotClient, profileId: string, knownRooms: readonly string[]): Promise<void> {
  for (const roomId of knownRooms) {
    try {
      const roomDb = new AppDbBotClient(roomId);
      const result = await roomDb.query('meeting_speakers', 'room', {
        where: [{ field: 'profileId', op: '==', value: profileId }],
        limit: 1000,
      });
      for (const row of extractDbRecords(result)) {
        await roomDb.update('meeting_speakers', 'room', row._id, { profileId: '', pendingEmbedding: '' });
      }
    } catch (error) {
      console.warn('[profile-store] xoá liên kết profile thất bại ở phòng', roomId, error instanceof Error ? error.message : error);
    }
  }
  await db.delete(COLLECTION, SCOPE, profileId);
}
