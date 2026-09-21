/**
 * CRUD over the GLOBAL `speaker_profiles` collection (App DB `scope:'global'`,
 * addressed room-lessly per D-05 — never construct `AppDbBotClient` with a
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
import { cosineSimilarity } from '../../shared/cosine.js';
import { AppDbBotClient, extractDbRecords, type DbRow } from '../hub/app-db-bot-client.js';
import { openEmbedding, parseSealedEmbedding, sealEmbedding, type SealedEmbedding } from './voiceprint-crypto.js';

/**
 * Canonical enrolment-source taxonomy (plan.md finding #6/#8) — recorded on
 * every stored embedding so phase 7's hygiene audit can tell a human-confirmed
 * vector from an automatic guess. Also the value phase-1 diagnostics' `enrol`
 * event uses for its own `source` field — this is the one taxonomy, not two.
 * `undefined`/absent on a decoded legacy embedding means "sealed before this
 * field existed".
 */
export type EnrolSource = 'user-live' | 'user-post' | 'auto-post';

export const EMBEDDING_CAP = 20;
const COLLECTION = 'speaker_profiles';
const SCOPE = 'global' as const;

export interface StoredEmbedding {
  vector: Float32Array;
  meetingId: string;
  durationSec: number;
  createdAt: string;
  /** `${meetingId}:${speakerKey}` — identifies which meeting SPEAKER this vector came from (not just which meeting), so a repeated enrol for the SAME speaker replaces rather than appends (idempotent enrol, plan.md § Requirements). Empty on a legacy embedding sealed before this field existed. */
  speakerKey: string;
  source?: EnrolSource;
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
  return { vector, meetingId: '', durationSec: 0, createdAt: sealed.createdAt, speakerKey: '' };
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
  speakerKey?: string;
  source?: EnrolSource;
}

function sealStoredEmbedding(vector: Float32Array, meta: { profileId: string; meetingId: string; durationSec: number; createdAt: string; speakerKey?: string; source?: EnrolSource }): string {
  const sealed = sealEmbedding(vector, { profileId: meta.profileId, createdAt: meta.createdAt });
  const envelope: StoredEmbeddingEnvelope = { ...sealed, meetingId: meta.meetingId, durationSec: meta.durationSec, speakerKey: meta.speakerKey, source: meta.source };
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
    speakerKey: typeof envelope.speakerKey === 'string' ? envelope.speakerKey : '',
    source: envelope.source,
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

// ---- workspace-global speaker_profiles cache (shared across meetings/callers, TTL 10min) ----
// Lives here (not in the live chunk worker) because EVERY embedding-mutating
// function below (`enrolEmbedding`, `removeEmbeddingsOfMeeting`,
// `pruneOutlierEmbeddings`, `deleteProfile`) is this module's own choke point
// for changing what a match can see — invalidating from inside those
// functions is the only way "any enrol happens in this process" (plan.md)
// covers every enrol site (live one-shot, post-meeting auto/user, relabel,
// prune) without every call site remembering to do it itself.
const PROFILE_CACHE_TTL_MS = 10 * 60 * 1000;
let profileCache: { at: number; profiles: SpeakerProfile[] } | null = null;

/** `listProfiles`, cached for up to `PROFILE_CACHE_TTL_MS` — the live chunk worker's per-chunk profile-match pass uses this instead of `listProfiles` directly so it never re-queries App DB on every chunk. */
export async function cachedProfiles(db: AppDbBotClient): Promise<SpeakerProfile[]> {
  if (profileCache && Date.now() - profileCache.at < PROFILE_CACHE_TTL_MS) return profileCache.profiles;
  const profiles = await listProfiles(db);
  profileCache = { at: Date.now(), profiles };
  return profiles;
}

/** Drops the cached `speaker_profiles` list — called by every function in this module that changes a profile's embeddings, so the very next `cachedProfiles` call sees the change instead of waiting up to `PROFILE_CACHE_TTL_MS`. */
export function invalidateProfileCache(): void {
  profileCache = null;
}

/** Test-only: forces the next `cachedProfiles` call to re-query. */
export function resetProfileCacheForTests(): void {
  invalidateProfileCache();
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

/** `user-post` vectors get their OWN sub-cap, enforced only by other `user-post` vectors (never by cap pressure from another source — see `evictForCap`). */
const USER_POST_SUBCAP = 10;

/**
 * Enforces `EMBEDDING_CAP` (20) WITHOUT plain FIFO across sources (plan.md:
 * "never FIFO across sources") — a human-confirmed vector must never be
 * silently displaced by an automatic guess just because it happens to be
 * older. Two passes, both oldest-first (array order is chronological
 * insertion order throughout a profile's life — see the module header):
 *
 *  1. `user-post` sub-cap: only OTHER `user-post` vectors evict a `user-post`
 *     vector, once there are more than `USER_POST_SUBCAP`.
 *  2. Global cap: while still over `EMBEDDING_CAP`, evict the oldest
 *     `auto-post` vector; once none remain, the oldest `legacy` (no
 *     `source` — sealed before this field existed) vector; once none of
 *     those remain either, the oldest `user-live` vector. `user-post`
 *     vectors are NEVER touched here — they are protected from cap pressure
 *     coming from any other source, by design.
 */
function evictForCap(embeddings: readonly StoredEmbedding[]): StoredEmbedding[] {
  let result = [...embeddings];

  const userPostIndices = result.reduce<number[]>((acc, e, i) => {
    if (e.source === 'user-post') acc.push(i);
    return acc;
  }, []);
  if (userPostIndices.length > USER_POST_SUBCAP) {
    const evictCount = userPostIndices.length - USER_POST_SUBCAP;
    const evictIndices = new Set(userPostIndices.slice(0, evictCount));
    result = result.filter((_, i) => !evictIndices.has(i));
  }

  const evictionPriority: readonly (EnrolSource | undefined)[] = ['auto-post', undefined, 'user-live'];
  while (result.length > EMBEDDING_CAP) {
    let removeAt = -1;
    for (const source of evictionPriority) {
      removeAt = result.findIndex((e) => e.source === source);
      if (removeAt !== -1) break;
    }
    if (removeAt === -1) break; // only `user-post` left — protected, cap left unenforced rather than touching it
    result.splice(removeAt, 1);
  }

  return result;
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
  /** REQUIRED at compile time — every enrol site must say where the vector came from (plan.md § Requirements: "no enrol site is untagged"). */
  source: EnrolSource;
  /** Identifies which meeting SPEAKER this vector is for (`sessionSpeakerId` for a live enrol, `speakerId` for a post-meeting one) — enables the idempotent-enrol replace-not-append rule below. */
  speakerKey: string;
  /**
   * Other `speakerKey`s (same `meetingId`) that identify the SAME real person
   * under a DIFFERENT key — e.g. a post-meeting `user-post` enrol also
   * purges the live `sessionSpeakerId` key a prior one-shot `user-live` enrol
   * used, so live-then-post never leaves two vectors for one person in one
   * meeting (the one-vector-per-(profileId,meetingId,person) invariant,
   * which the primary `speakerKey`-only dedupe below cannot see on its own
   * since the two enrol sites key by different ids for the same person).
   */
  alsoReplaceSpeakerKeys?: readonly string[];
}

/**
 * Seals + appends one embedding to a profile: re-reads the row (under the
 * in-process lock) immediately before writing, caps to the `EMBEDDING_CAP`
 * MOST RECENT embeddings, recomputes `centroid`, bumps `sampleCount`/
 * `lastSeenAt`. `dim` is taken from the incoming vector — a model swap that
 * changes dimensionality naturally "wins" going forward; `speaker-matcher.ts`
 * already skips stored embeddings whose length differs from the query vector.
 *
 * Idempotent per `(profileId, meetingId, speakerKey)`: any embedding already
 * on this profile for the SAME meeting+speaker is dropped before the new one
 * is appended — a repeated `speaker_resolve`/job pass on a named-but-not-yet-
 * enrolled row REPLACES its vector, never appends a duplicate.
 */
/** Returns the profile's `sampleCount` AFTER this enrolment — diagnostics-only convenience so a caller does not need a second read just to log `vectorCountAfter`. */
export async function enrolEmbedding(db: AppDbBotClient, profileId: string, input: EnrolInput): Promise<number> {
  return withProfileLock(profileId, async () => {
    const row = await db.getById(COLLECTION, SCOPE, profileId);
    if (!row) throw new Error(`enrolEmbedding: profile ${profileId} no longer exists.`);
    const current = rowToProfile(row);
    const createdAt = new Date().toISOString();

    const purgeKeys = new Set<string>([input.speakerKey, ...(input.alsoReplaceSpeakerKeys ?? [])]);
    const withoutSameSource = current.embeddings.filter((e) => !(e.meetingId === input.meetingId && purgeKeys.has(e.speakerKey)));
    const nextEmbeddings = evictForCap([
      ...withoutSameSource,
      { vector: input.vector, meetingId: input.meetingId, durationSec: input.durationSec, createdAt, speakerKey: input.speakerKey, source: input.source },
    ]);
    const centroid = computeCentroid(nextEmbeddings.map((e) => e.vector));

    const embeddingsJson = nextEmbeddings.map((e) =>
      sealStoredEmbedding(e.vector, { profileId, meetingId: e.meetingId, durationSec: e.durationSec, createdAt: e.createdAt, speakerKey: e.speakerKey, source: e.source }),
    );
    const centroidJson = centroid ? JSON.stringify(sealEmbedding(centroid, { profileId, createdAt })) : '';

    await db.update(COLLECTION, SCOPE, profileId, {
      embeddings: embeddingsJson,
      centroid: centroidJson,
      dim: input.vector.length,
      sampleCount: nextEmbeddings.length,
      lastSeenAt: createdAt,
    });
    invalidateProfileCache();
    return nextEmbeddings.length;
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
    const embeddingsJson = remaining.map((e) =>
      sealStoredEmbedding(e.vector, { profileId, meetingId: e.meetingId, durationSec: e.durationSec, createdAt: e.createdAt, speakerKey: e.speakerKey, source: e.source }),
    );
    const centroidJson = centroid ? JSON.stringify(sealEmbedding(centroid, { profileId, createdAt })) : '';

    await db.update(COLLECTION, SCOPE, profileId, {
      embeddings: embeddingsJson,
      centroid: centroidJson,
      sampleCount: remaining.length,
    });
    invalidateProfileCache();
  });
}

export async function renameProfile(db: AppDbBotClient, profileId: string, displayName: string): Promise<void> {
  await db.update(COLLECTION, SCOPE, profileId, { displayName, displayNameNormalized: normalizedName(displayName) });
}

export async function linkPrivosUser(db: AppDbBotClient, profileId: string, privosUserId: string, privosUsername?: string): Promise<void> {
  await db.update(COLLECTION, SCOPE, profileId, { privosUserId, privosUsername: privosUsername ?? '' });
}

/** A human-confirmed identity to resolve/create a profile for, shared by every `user-live`/`user-post` enrol site. */
export interface EnrolIdentity {
  displayName: string;
  privosUserId?: string;
  /** mode `merge` — an EXPLICIT existing target; never auto-created when set. */
  profileId?: string;
  createdByUserId: string;
  createdInRoomId?: string;
}

/**
 * Shared find-or-create-then-enrol used by every human-confirmed identity
 * path (`speaker-resolve-tool.ts`'s 3 modes, `resolve-speakers.ts`'s
 * `user-post` branch) — one place owns "which profile does this identity
 * mean", so the tool and the job can never diverge on it (plan.md
 * Architecture: "no copy"). Resolution order: an explicit `profileId` (mode
 * `merge`, never created if missing — returns `null`); else an existing
 * profile by `privosUserId`; else an existing profile by `displayName`; else
 * a freshly created profile. Returns `null` only when `profileId` was given
 * but no longer exists — the caller reports `profile_not_found` rather than
 * silently creating a different profile than the one the human picked.
 */
export async function findOrCreateProfileAndEnrol(
  db: AppDbBotClient,
  identity: EnrolIdentity,
  vector: Float32Array,
  meta: { meetingId: string; durationSec: number; source: EnrolSource; speakerKey: string; alsoReplaceSpeakerKeys?: readonly string[] },
): Promise<{ profile: SpeakerProfile; vectorCountAfter: number } | null> {
  let profile: SpeakerProfile | null = null;
  if (identity.profileId) {
    profile = await getProfile(db, identity.profileId);
    if (!profile) return null;
  } else {
    if (identity.privosUserId) profile = await findProfileByPrivosUserId(db, identity.privosUserId);
    if (!profile) profile = await findProfileByName(db, identity.displayName);
    if (!profile) {
      profile = await createProfile(db, {
        displayName: identity.displayName,
        createdByUserId: identity.createdByUserId,
        createdInRoomId: identity.createdInRoomId,
        privosUserId: identity.privosUserId,
      });
    } else if (identity.privosUserId && !profile.privosUserId) {
      await linkPrivosUser(db, profile.id, identity.privosUserId);
    }
  }

  const vectorCountAfter = await enrolEmbedding(db, profile.id, {
    vector,
    meetingId: meta.meetingId,
    durationSec: meta.durationSec,
    source: meta.source,
    speakerKey: meta.speakerKey,
    alsoReplaceSpeakerKeys: meta.alsoReplaceSpeakerKeys,
  });
  return { profile, vectorCountAfter };
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
      console.warn('[profile-store] failed to clear profile link in room', roomId, error instanceof Error ? error.message : error);
    }
  }
  await db.delete(COLLECTION, SCOPE, profileId);
  invalidateProfileCache();
}

// ---------------------------------------------------------------- hygiene

/** `cosineSimilarity` without its length-mismatch throw — a model swap can leave same-profile vectors at different dims. */
function safeCosine(a: Float32Array, b: Float32Array): number {
  return a.length === b.length ? cosineSimilarity(a, b) : 0;
}

export interface ProfileHealth {
  /** Vector counts by enrolment source — `legacy` = sealed before `source` existed (`StoredEmbedding.source` absent). Scalars only, never a vector. */
  vectorCounts: { userLive: number; userPost: number; autoPost: number; legacy: number };
  /** Lowest pairwise cosine across every stored vector — `1` (trivially "coherent") with fewer than 2 vectors. */
  minPairwiseCosine: number;
  /** Mean pairwise cosine across every stored vector pair — `1` with fewer than 2 vectors. */
  meanPairwiseCosine: number;
  /** Count of vectors whose OWN mean cosine to every other vector in the profile falls below `matchThreshold` — a vector out of step with the rest of the profile. */
  outlierCount: number;
}

/** Every vector's mean cosine to every OTHER vector in the same profile — `1` for a lone vector (nothing to compare against). Shared by `profileHealth` and `pruneOutlierEmbeddings` so "outlier" means the exact same thing in both. */
function meanCosineToOthers(vectors: readonly Float32Array[], index: number): number {
  if (vectors.length < 2) return 1;
  let sum = 0;
  for (let j = 0; j < vectors.length; j++) {
    if (j === index) continue;
    sum += safeCosine(vectors[index], vectors[j]);
  }
  return sum / (vectors.length - 1);
}

/**
 * Pure scalar summary of a profile's stored vectors — never returns a vector,
 * only counts and cosine numbers (plan.md: "vectors never leave the server;
 * health numbers are scalars"). `matchThreshold` is the SAME bar
 * `resolve-speakers.ts#readMatchThreshold` returns, so "outlier" here means
 * exactly what would fail to match this profile's own other vectors.
 */
export function profileHealth(profile: SpeakerProfile, matchThreshold: number): ProfileHealth {
  const vectorCounts = { userLive: 0, userPost: 0, autoPost: 0, legacy: 0 };
  for (const e of profile.embeddings) {
    if (e.source === 'user-live') vectorCounts.userLive++;
    else if (e.source === 'user-post') vectorCounts.userPost++;
    else if (e.source === 'auto-post') vectorCounts.autoPost++;
    else vectorCounts.legacy++;
  }

  const vectors = profile.embeddings.map((e) => e.vector);
  if (vectors.length < 2) {
    return { vectorCounts, minPairwiseCosine: 1, meanPairwiseCosine: 1, outlierCount: 0 };
  }

  let min = 1;
  let sum = 0;
  let pairCount = 0;
  for (let i = 0; i < vectors.length; i++) {
    for (let j = i + 1; j < vectors.length; j++) {
      const cos = safeCosine(vectors[i], vectors[j]);
      min = Math.min(min, cos);
      sum += cos;
      pairCount++;
    }
  }

  let outlierCount = 0;
  for (let i = 0; i < vectors.length; i++) {
    if (meanCosineToOthers(vectors, i) < matchThreshold) outlierCount++;
  }

  return { vectorCounts, minPairwiseCosine: min, meanPairwiseCosine: pairCount > 0 ? sum / pairCount : 1, outlierCount };
}

export interface PruneResult {
  removed: number;
  remaining: number;
}

/**
 * Removes vectors flagged as outliers by {@link profileHealth}'s exact rule
 * (mean cosine to every other vector < `matchThreshold`) — `user-live`/
 * `user-post` vectors are NEVER candidates, however low their score (plan.md:
 * "never touches user-*"); a full reset of a human-confirmed vector is
 * `speaker_profile_delete` + re-enrol, not this. Refuses to drop the profile
 * below 1 vector: if flagged outliers would empty it, the WORST ones are
 * removed first, up to `count - 1`, leaving at least one.
 */
export async function pruneOutlierEmbeddings(db: AppDbBotClient, profileId: string, matchThreshold: number): Promise<PruneResult> {
  return withProfileLock(profileId, async () => {
    const row = await db.getById(COLLECTION, SCOPE, profileId);
    if (!row) throw new Error(`pruneOutlierEmbeddings: profile ${profileId} no longer exists.`);
    const current = rowToProfile(row);
    const vectors = current.embeddings.map((e) => e.vector);

    if (vectors.length < 2) return { removed: 0, remaining: vectors.length };

    const prunable = current.embeddings
      .map((e, i) => ({ index: i, source: e.source, meanCosine: meanCosineToOthers(vectors, i) }))
      .filter((x) => x.source !== 'user-live' && x.source !== 'user-post' && x.meanCosine < matchThreshold)
      .sort((a, b) => a.meanCosine - b.meanCosine); // worst first

    if (prunable.length === 0) return { removed: 0, remaining: current.embeddings.length };

    const maxRemovable = Math.max(0, current.embeddings.length - 1);
    const toRemove = new Set(prunable.slice(0, maxRemovable).map((x) => x.index));
    const remaining = current.embeddings.filter((_, i) => !toRemove.has(i));

    const createdAt = new Date().toISOString();
    const centroid = computeCentroid(remaining.map((e) => e.vector));
    const embeddingsJson = remaining.map((e) =>
      sealStoredEmbedding(e.vector, { profileId, meetingId: e.meetingId, durationSec: e.durationSec, createdAt: e.createdAt, speakerKey: e.speakerKey, source: e.source }),
    );
    const centroidJson = centroid ? JSON.stringify(sealEmbedding(centroid, { profileId, createdAt })) : '';

    await db.update(COLLECTION, SCOPE, profileId, {
      embeddings: embeddingsJson,
      centroid: centroidJson,
      sampleCount: remaining.length,
    });
    invalidateProfileCache();
    return { removed: toRemove.size, remaining: remaining.length };
  });
}
