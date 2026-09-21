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
import { openEmbedding, sealEmbedding, type SealedEmbedding } from '../speaker/voiceprint-crypto.js';
import { MeetingSessionRegistry, sessionRegistries, type LoadableSpeakerRow, type NameSource } from '../speaker/session-speaker-registry.js';

const COLLECTION = 'meeting_speakers';
const SCOPE = 'room' as const;

function asNameSource(value: unknown): NameSource | undefined {
  return value === 'user' || value === 'async' || value === 'live' ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function centroidFromRow(row: DbRow): Float32Array | null {
  const json = typeof row.pendingEmbedding === 'string' && row.pendingEmbedding ? row.pendingEmbedding : null;
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as Partial<SealedEmbedding>;
    if (typeof parsed.ct !== 'string') return null;
    return openEmbedding(parsed as SealedEmbedding);
  } catch {
    return null;
  }
}

function rowToLoadable(row: DbRow): LoadableSpeakerRow | null {
  if (typeof row.sessionSpeakerId !== 'string' || !row.sessionSpeakerId) return null;
  return {
    sessionSpeakerId: row.sessionSpeakerId,
    sonioxLabels: asStringArray(row.sonioxLabels),
    centroid: centroidFromRow(row),
    liveSpeechSec: typeof row.liveSpeechSec === 'number' ? row.liveSpeechSec : 0,
    profileId: typeof row.profileId === 'string' && row.profileId ? row.profileId : undefined,
    displayName: typeof row.displayName === 'string' && row.displayName ? row.displayName : undefined,
    nameSource: asNameSource(row.nameSource),
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
    .map(rowToLoadable)
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
  if (snapshot.length === 0) {
    registry.markPersisted();
    return;
  }

  const existingResult = await db.query(COLLECTION, SCOPE, {
    where: [{ field: 'meeting', op: '==', value: meetingId }],
    limit: 1000,
  });
  const existing = extractDbRecords(existingResult);
  const bySessionId = new Map(existing.filter((r) => typeof r.sessionSpeakerId === 'string').map((r) => [r.sessionSpeakerId as string, r]));

  const snapshotHash = registry.snapshotHash();
  const createdAt = new Date().toISOString();

  for (const speaker of snapshot) {
    const centroid = registry.centroidFor(speaker.sessionSpeakerId);
    const pendingEmbedding = centroid
      ? JSON.stringify(sealEmbedding(centroid, { profileId: `live:${meetingId}:${speaker.sessionSpeakerId}`, createdAt }))
      : undefined;

    const data: Record<string, unknown> = {
      meeting: meetingId,
      sessionSpeakerId: speaker.sessionSpeakerId,
      sonioxLabels: speaker.sonioxLabels,
      nameSource: speaker.nameSource ?? 'live',
      liveSpeechSec: speaker.liveSpeechSec,
      liveUpdatedAt: createdAt,
      snapshotHash,
      colorKey: speaker.colorKey,
      resolved: speaker.resolved,
    };
    if (speaker.displayName !== undefined) data.displayName = speaker.displayName;
    if (speaker.profileId !== undefined) data.profileId = speaker.profileId;
    if (speaker.liveConfidence !== undefined) data.liveConfidence = speaker.liveConfidence;
    if (pendingEmbedding !== undefined) data.pendingEmbedding = pendingEmbedding;

    const row = bySessionId.get(speaker.sessionSpeakerId);
    if (row) await db.update(COLLECTION, SCOPE, row._id, data);
    else await db.create(COLLECTION, SCOPE, data);
  }

  registry.markPersisted();
}
