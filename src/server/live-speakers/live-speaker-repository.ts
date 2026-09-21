/**
 * `meeting_speakers` persistence for the LIVE registry — keyed by
 * `sessionSpeakerId`, distinct from the async pass's own key (`speakerId`,
 * owned by `jobs/meeting-repository.ts`). Both upserts only ever write the
 * fields present on their own input, so a live write and an async write
 * landing on the SAME row never clobber each other's fields (plan.md's
 * "merge live fields, never overwrite" requirement holds by construction, not by
 * a runtime merge step).
 *
 * `upsertAll` seals the centroid the same way P4 seals every other embedding
 * (`voiceprint-crypto.sealEmbedding`) and is gated by
 * `MeetingSessionRegistry.snapshotChanged()` so a meeting writes App DB at
 * most once per part (S2-14).
 */
import { extractDbRecords, type AppDbBotClient, type DbRow } from '../hub/app-db-bot-client.js';
import { openEmbedding, openEmbeddingWithMeta, type SealedEmbedding } from '../speaker/voiceprint-crypto.js';
import { sealPendingEmbedding } from '../speaker/resolve-speakers.js';
import { MeetingSessionRegistry, sessionRegistries, type LoadableSpeakerRow, type NameSource } from '../speaker/session-speaker-registry.js';

const COLLECTION = 'meeting_speakers';
const SCOPE = 'room' as const;

function asNameSource(value: unknown): NameSource | undefined {
  return value === 'user' || value === 'async' || value === 'live' ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * Decrypts `row.pendingEmbedding` back into a centroid for `loadFrom`
 * REHYDRATION ONLY (never enrolment — that gate lives entirely in
 * `resolve-speakers.ts#openPendingEmbedding`, which this function does not
 * call). Tries the current sealed-meta shape first, bound to this row's own
 * `live:<meetingId>:<sessionSpeakerId>` id; falls back to an OLD-shape row
 * (plain `sealEmbedding`, pre-phase-3 production output, no coherence meta at
 * all) so a meeting recorded before this deploy still restores its labels
 * after a restart.
 */
function centroidFromRow(row: DbRow, meetingId: string, sessionSpeakerId: string): Float32Array | null {
  const json = typeof row.pendingEmbedding === 'string' && row.pendingEmbedding ? row.pendingEmbedding : null;
  if (!json) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const sealed = parsed as Partial<SealedEmbedding>;
  if (typeof sealed.ct !== 'string') return null;

  const expectedProfileId = `live:${meetingId}:${sessionSpeakerId}`;
  const withMeta = openEmbeddingWithMeta<unknown>(sealed as SealedEmbedding, expectedProfileId);
  if (withMeta) return withMeta.vector;

  // Old-shape row: plain vector, no meta — still bound-checked before trusting it.
  if (sealed.profileId !== expectedProfileId) return null;
  return openEmbedding(sealed as SealedEmbedding);
}

function rowToLoadable(row: DbRow, meetingId: string): LoadableSpeakerRow | null {
  if (typeof row.sessionSpeakerId !== 'string' || !row.sessionSpeakerId) return null;
  return {
    sessionSpeakerId: row.sessionSpeakerId,
    sonioxLabels: asStringArray(row.sonioxLabels),
    centroid: centroidFromRow(row, meetingId, row.sessionSpeakerId),
    liveSpeechSec: typeof row.liveSpeechSec === 'number' ? row.liveSpeechSec : 0,
    profileId: typeof row.profileId === 'string' && row.profileId ? row.profileId : undefined,
    displayName: typeof row.displayName === 'string' && row.displayName ? row.displayName : undefined,
    nameSource: asNameSource(row.nameSource),
    privosUserId: typeof row.privosUserId === 'string' && row.privosUserId ? row.privosUserId : undefined,
    liveConfidence: typeof row.liveConfidence === 'number' ? row.liveConfidence : undefined,
    colorKey: typeof row.colorKey === 'string' && row.colorKey ? row.colorKey : undefined,
  };
}

/** Every `meeting_speakers` row for `meetingId` that carries a `sessionSpeakerId` — used to rebuild the in-memory registry after a restart/eviction. */
export async function loadForMeeting(db: AppDbBotClient, meetingId: string): Promise<LoadableSpeakerRow[]> {
  const result = await db.query(COLLECTION, SCOPE, {
    where: [{ field: 'meeting', op: '==', value: meetingId }],
    limit: 1000,
  });
  return extractDbRecords(result)
    .map((row) => rowToLoadable(row, meetingId))
    .filter((row): row is LoadableSpeakerRow => row !== null);
}

/**
 * Get-or-create this meeting's in-memory registry. On first touch after a
 * restart/eviction (the store did not already have it), rebuilds it from
 * `meeting_speakers` so live labels never reset to "Speaker 1".
 */
export async function ensureRegistry(db: AppDbBotClient, meetingId: string): Promise<MeetingSessionRegistry> {
  const existed = sessionRegistries.has(meetingId);
  const registry = sessionRegistries.get(meetingId);
  if (!existed) {
    const rows = await loadForMeeting(db, meetingId);
    if (rows.length > 0) registry.loadFrom(rows);
  }
  return registry;
}

/**
 * Writes every session speaker's current snapshot to `meeting_speakers`,
 * ONLY when `registry.snapshotChanged()` — a no-op call every other chunk is
 * expected and cheap (one extra function call, no network request).
 */
export async function upsertAll(db: AppDbBotClient, meetingId: string, registry: MeetingSessionRegistry): Promise<void> {
  if (!registry.snapshotChanged()) return;
  const snapshot = registry.snapshot();
  // Captured NOW, together with `snapshot`, before any await below — this is
  // the hash of what this call is ABOUT TO WRITE. `markPersisted` at the end
  // uses this same value rather than re-deriving one from whatever the
  // registry looks like once every write has finished (plan.md red-team
  // finding #5: a re-hash there can mark an unwritten later mutation as
  // already persisted).
  const snapshotHash = registry.snapshotHash();
  if (snapshot.length === 0) {
    registry.markPersisted(snapshotHash);
    return;
  }

  const existingResult = await db.query(COLLECTION, SCOPE, {
    where: [{ field: 'meeting', op: '==', value: meetingId }],
    limit: 1000,
  });
  const existing = extractDbRecords(existingResult);
  const bySessionId = new Map(existing.filter((r) => typeof r.sessionSpeakerId === 'string').map((r) => [r.sessionSpeakerId as string, r]));

  const createdAt = new Date().toISOString();

  for (const speaker of snapshot) {
    const row = bySessionId.get(speaker.sessionSpeakerId);
    // Never downgrade a DB row already confirmed by a human (defense in depth
    // — the primary guard is running `speaker_resolve`'s mutation+write on this
    // SAME keyed queue, see `chunk-worker.ts#runOnMeetingQueue`). A row can only
    // reach `nameSource:'user'` in the first place through a snapshot that
    // ALSO already carries it (the tool mutates the registry itself via
    // `applyUserIdentity`), so this only ever guards a genuinely stale write.
    const preserveIdentity = row?.nameSource === 'user' && speaker.nameSource !== 'user';

    const coherence = registry.coherenceFor(speaker.sessionSpeakerId);
    const centroid = registry.centroidFor(speaker.sessionSpeakerId);
    const pendingEmbedding =
      centroid && coherence
        ? sealPendingEmbedding(centroid, {
            profileId: `live:${meetingId}:${speaker.sessionSpeakerId}`,
            minPairwiseCosine: coherence.minPairwiseCosine,
            rangeCount: coherence.rangeCount,
            durationSec: coherence.durationSec,
          })
        : undefined;

    const data: Record<string, unknown> = {
      meeting: meetingId,
      sessionSpeakerId: speaker.sessionSpeakerId,
      sonioxLabels: speaker.sonioxLabels,
      liveSpeechSec: speaker.liveSpeechSec,
      liveUpdatedAt: createdAt,
      snapshotHash,
      colorKey: speaker.colorKey,
    };
    if (pendingEmbedding !== undefined) data.pendingEmbedding = pendingEmbedding;

    if (preserveIdentity) {
      // Leave displayName/profileId/nameSource/privosUserId/resolved exactly as the DB already has them.
    } else {
      data.nameSource = speaker.nameSource ?? 'live';
      data.resolved = speaker.resolved;
      if (speaker.displayName !== undefined) data.displayName = speaker.displayName;
      if (speaker.profileId !== undefined) data.profileId = speaker.profileId;
      if (speaker.privosUserId !== undefined) data.privosUserId = speaker.privosUserId;
      if (speaker.liveConfidence !== undefined) data.liveConfidence = speaker.liveConfidence;
    }

    if (row) await db.update(COLLECTION, SCOPE, row._id, data);
    else await db.create(COLLECTION, SCOPE, data);
  }

  registry.markPersisted(snapshotHash);
}
