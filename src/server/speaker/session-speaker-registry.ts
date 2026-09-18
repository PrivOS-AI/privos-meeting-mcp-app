/**
 * In-memory (per `meetingId`) live speaker registry — P5's core state machine
 * (QĐ-16/S2-05). A realtime provider's `speaker` label (`s{sessionIndex}:{n}`)
 * is only a HINT, never an identity: every embedding this module receives is
 * re-verified against the centroid of whichever session speaker currently
 * owns that label BEFORE being folded in. A label the provider recycles for a
 * different voice opens a fresh instance (`label@2`, `label@3`, ...) instead
 * of contaminating the original speaker's centroid; a link from label to
 * session speaker only becomes "sticky" (trusted without re-verification
 * failing it) after >=2 independent turns and >= `LIVE_MIN_SPEECH_SEC` of
 * speech.
 *
 * Pure in-memory bookkeeping — no I/O. Persistence to App DB is
 * `live-speakers/live-speaker-repository.ts`; persistence to Files
 * (`live-turns.json`) is `media/live-turns-store.ts`. `chunk-worker.ts`
 * orchestrates both around this module.
 */
import { randomUUID } from 'node:crypto';

import { cosineSimilarity } from '../../shared/cosine.js';
import { env } from '../env.js';
import { matchSpeaker } from './speaker-matcher.js';
import type { SpeakerProfile } from './profile-store.js';

const EMBEDDING_CAP = 10;
const PALETTE = ['blue', 'gold', 'green', 'purple', 'coral', 'teal'] as const;
/** Idle-registry eviction (S2-13) — no chunk processed for this long -> the registry-of-registries drops the meeting entirely. */
export const REGISTRY_TTL_MS = 30 * 60 * 1000;

export type NameSource = 'user' | 'async' | 'live';

export interface ChunkSegment {
  speaker: string;
  startMs: number;
  endMs: number;
  final: boolean;
}

export interface SessionSpeakerSnapshot {
  sessionSpeakerId: string;
  sonioxLabels: string[];
  displayName?: string;
  profileId?: string;
  nameSource?: NameSource;
  liveConfidence?: number;
  liveSpeechSec: number;
  colorKey: string;
  resolved: boolean;
  mergedInto?: string;
}

/** One turn folded into the registry since the last `settledTurns()` read — the unit `live-turns.json` persists. */
export interface SettledTurn {
  sessionSpeakerId: string;
  startMs: number;
  endMs: number;
  sonioxLabel: string;
}

/** A row read back from `meeting_speakers` after a restart/eviction — the repository decrypts `pendingEmbedding` into `centroid` before calling `loadFrom`; this module never touches crypto itself. */
export interface LoadableSpeakerRow {
  sessionSpeakerId: string;
  sonioxLabels: string[];
  centroid: Float32Array | null;
  liveSpeechSec: number;
  profileId?: string;
  displayName?: string;
  nameSource?: NameSource;
  liveConfidence?: number;
  colorKey?: string;
}

interface SessionSpeaker {
  sessionSpeakerId: string;
  sonioxLabels: string[];
  centroid: Float32Array | null;
  embeddings: Float32Array[];
  speechSec: number;
  turnCount: number;
  sticky: boolean;
  profileId?: string;
  displayName?: string;
  nameSource?: NameSource;
  liveConfidence?: number;
  profileAttempts: number;
  colorKey: string;
  mergedInto?: string;
}

function meanNormalize(vectors: readonly Float32Array[]): Float32Array {
  const dim = vectors[0].length;
  const out = new Float32Array(dim);
  for (const v of vectors) {
    if (v.length !== dim) continue;
    for (let i = 0; i < dim; i++) out[i] += v[i];
  }
  for (let i = 0; i < dim; i++) out[i] /= vectors.length;
  return out;
}

/** `s0:1` -> `s0:1@2` -> `s0:1@3` — next free instance suffix for a label a provider reused on a different voice. */
function nextInstanceLabel(label: string, alreadyTaken: ReadonlySet<string>): string {
  const base = label.split('@')[0];
  let n = 2;
  while (alreadyTaken.has(`${base}@${n}`)) n++;
  return `${base}@${n}`;
}

function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** One meeting's live speaker state — created empty, optionally rebuilt via `loadFrom` right after (see `live-speaker-repository.ensureRegistry`). */
export class MeetingSessionRegistry {
  private readonly byId = new Map<string, SessionSpeaker>();
  private readonly byLabel = new Map<string, SessionSpeaker>();
  private readonly processedTurns = new Set<string>();
  private readonly deferredSegments: ChunkSegment[] = [];
  private pendingSettled: SettledTurn[] = [];
  private ringPcm: Float32Array = new Float32Array(0);
  private decodedSecTotal = 0;
  private lastProcessedSeq = -1;
  private discontinuous = false;
  private degradedFlag = false;
  private lastPersistedHash = '';

  /** Last time a chunk was processed (or the registry was created) — the TTL clock (S2-13). */
  lastActivityAt = Date.now();

  constructor(public readonly meetingId: string) {}

  private nextColor(): string {
    return PALETTE[this.byId.size % PALETTE.length];
  }

  private createSessionSpeaker(): SessionSpeaker {
    const speaker: SessionSpeaker = {
      sessionSpeakerId: randomUUID(),
      sonioxLabels: [],
      centroid: null,
      embeddings: [],
      speechSec: 0,
      turnCount: 0,
      sticky: false,
      profileAttempts: 0,
      colorKey: this.nextColor(),
    };
    this.byId.set(speaker.sessionSpeakerId, speaker);
    return speaker;
  }

  // ---------------------------------------------------------------- dedupe

  private turnKey(seg: Pick<ChunkSegment, 'speaker' | 'startMs'>): string {
    return `${seg.speaker}:${seg.startMs}`;
  }

  /** True when this exact `(speaker, startMs)` turn has already been embedded — a resent draft/final never embeds twice. */
  alreadyProcessed(seg: Pick<ChunkSegment, 'speaker' | 'startMs'>): boolean {
    return this.processedTurns.has(this.turnKey(seg));
  }

  private markProcessed(seg: Pick<ChunkSegment, 'speaker' | 'startMs'>): void {
    this.processedTurns.add(this.turnKey(seg));
  }

  // --------------------------------------------------------------- defer

  /** Turn vắt biên part (S2-03) — its audio is not fully decoded yet; retried on the NEXT chunk instead of being dropped. */
  defer(seg: ChunkSegment): void {
    this.deferredSegments.push(seg);
  }

  /** Every deferred turn, cleared — the caller re-attempts each one against the newly extended audio window. */
  takeDeferred(): ChunkSegment[] {
    return this.deferredSegments.splice(0, this.deferredSegments.length);
  }

  // ---------------------------------------------------------------- ring

  /** The overlap ring left by the previous chunk, consumed once — empty after a discontinuity (a failed/dropped chunk never lets audio bleed across the gap it left). */
  ringTake(): Float32Array {
    const ring = this.ringPcm;
    this.ringPcm = new Float32Array(0);
    return ring;
  }

  ringSet(pcm: Float32Array): void {
    this.ringPcm = pcm;
  }

  // --------------------------------------------------------------- clock

  /**
   * Seconds of audio decoded for this meeting strictly BEFORE `seq` — the
   * server-tracked "part start" used both to slice PCM and to validate a
   * span's own `startMs` really falls inside this part's window (never the
   * client's own claim, S2-05). Advances only via `noteDecoded`, which runs
   * in the worker's `finally` for EVERY chunk (success, failure, or drop) so
   * one bad chunk never permanently skews every chunk after it (S2-08).
   */
  decodedSecBefore(seq: number): number {
    if (this.lastProcessedSeq !== -1 && seq <= this.lastProcessedSeq) {
      console.warn('[session-speaker-registry] seq trùng/lùi so với chunk đã xử lý — dùng lại đồng hồ tích luỹ hiện có.', {
        meetingId: this.meetingId,
        seq,
        lastProcessedSeq: this.lastProcessedSeq,
      });
    }
    return this.decodedSecTotal;
  }

  /** Advances the clock by the ACTUALLY MEASURED part duration the client reported — never `seq * 60`. Must run for every chunk, in `finally`. */
  noteDecoded(seq: number, durationSec: number): void {
    this.decodedSecTotal += Math.max(0, durationSec);
    this.lastProcessedSeq = Math.max(this.lastProcessedSeq, seq);
    this.lastActivityAt = Date.now();
  }

  /** A chunk failed (or was evicted from the queue backlog before it ran) — the overlap ring can no longer be trusted, so it is cleared and `degraded` is raised for the UI. */
  markDiscontinuity(seq: number): void {
    this.discontinuous = true;
    this.degradedFlag = true;
    this.ringPcm = new Float32Array(0);
    this.lastProcessedSeq = Math.max(this.lastProcessedSeq, seq);
  }

  /** For a chunk dropped from the queue's backlog before `onChunkReady` ever ran — same clock-advance + discontinuity contract as a failed run (S2-08), called by the queue's `onDropped` hook. */
  markDropped(seq: number, durationMs: number): void {
    this.noteDecoded(seq, durationMs / 1000);
    this.markDiscontinuity(seq);
  }

  /** True since the last discontinuity — consumed by `chunk-worker.ts` to decide whether the just-taken overlap ring is trustworthy (it never is right after a gap; `ringTake()` already returns empty in that case, this is for logging/tests). */
  hadDiscontinuity(): boolean {
    return this.discontinuous;
  }

  /** `true` once any chunk has ever failed/been dropped for this meeting — surfaced on `meeting_live_speakers` so the UI can say "some segments could not be identified". Sticky for the registry's lifetime (does not clear itself). */
  isDegraded(): boolean {
    return this.degradedFlag;
  }

  // ------------------------------------------------------------- observe

  /**
   * Verifies + folds one embedding into the session speaker currently bound
   * to `label`. Re-verifies from scratch every time — nothing is ever
   * trusted purely because the label matches (QĐ-16). Deduplicates by
   * `(speaker, startMs)`: a turn already embedded (draft, then resent as
   * final) is a silent no-op.
   */
  observe(label: string, embedding: Float32Array, durSec: number, seg: ChunkSegment): void {
    if (this.alreadyProcessed(seg)) return;
    this.markProcessed(seg);

    let target = this.byLabel.get(label);
    if (target && target.sticky && target.centroid && cosineSimilarity(embedding, target.centroid) < env.speakerSessionMatchThreshold) {
      // The label was recycled for a different voice — detach it from its old
      // owner (whose centroid is left untouched) and open a fresh instance.
      this.byLabel.delete(label);
      label = nextInstanceLabel(label, new Set(target.sonioxLabels));
      target = undefined;
    }

    if (!target) {
      const hit = matchSpeaker(embedding, this.asPseudoProfiles(), env.speakerSessionMatchThreshold);
      target = hit.profileId ? this.byId.get(hit.profileId) : undefined;
      if (!target) target = this.createSessionSpeaker();
      if (!target.sonioxLabels.includes(label)) target.sonioxLabels.push(label);
      this.byLabel.set(label, target);
    }

    target.embeddings.push(embedding);
    if (target.embeddings.length > EMBEDDING_CAP) target.embeddings.splice(0, target.embeddings.length - EMBEDDING_CAP);
    target.centroid = meanNormalize(target.embeddings);
    target.speechSec += durSec;
    target.turnCount += 1;
    target.sticky = target.turnCount >= 2 && target.speechSec >= env.liveMinSpeechSec;

    this.pendingSettled.push({ sessionSpeakerId: target.sessionSpeakerId, startMs: seg.startMs, endMs: seg.endMs, sonioxLabel: label });
    this.lastActivityAt = Date.now();
    this.maybeMerge(target);
  }

  /** This meeting's OWN session speakers, reused as `speaker-matcher.ts` "profiles" (its `id` doubles as `sessionSpeakerId`) — lets `observe` reuse the exact same best-match-above-threshold logic P4 uses against real profiles. */
  private asPseudoProfiles(): SpeakerProfile[] {
    const out: SpeakerProfile[] = [];
    for (const speaker of this.byId.values()) {
      if (speaker.mergedInto || !speaker.centroid) continue;
      out.push({
        id: speaker.sessionSpeakerId,
        displayName: speaker.displayName ?? '',
        colorKey: speaker.colorKey,
        createdByUserId: '',
        embeddings: speaker.embeddings.map((vector) => ({ vector, meetingId: this.meetingId, durationSec: 0, createdAt: '' })),
        centroid: speaker.centroid,
        dim: speaker.centroid.length,
        sampleCount: speaker.embeddings.length,
      });
    }
    return out;
  }

  /** After every centroid update, checks for convergence with another session speaker; merges at most one pair per `observe()` call (the next call re-checks, so a chain of merges resolves over a few turns rather than needing recursion here). */
  private maybeMerge(changed: SessionSpeaker): void {
    if (!changed.centroid) return;
    for (const other of this.byId.values()) {
      if (other === changed || other.mergedInto || !other.centroid) continue;
      if (cosineSimilarity(changed.centroid, other.centroid) < env.speakerSessionMergeThreshold) continue;

      const [winner, loser] = changed.speechSec >= other.speechSec ? [changed, other] : [other, changed];
      for (const label of loser.sonioxLabels) {
        if (!winner.sonioxLabels.includes(label)) winner.sonioxLabels.push(label);
        this.byLabel.set(label, winner);
      }
      winner.embeddings = [...winner.embeddings, ...loser.embeddings].slice(-EMBEDDING_CAP);
      winner.centroid = meanNormalize(winner.embeddings);
      winner.speechSec += loser.speechSec;
      winner.turnCount += loser.turnCount;
      winner.sticky = winner.turnCount >= 2 && winner.speechSec >= env.liveMinSpeechSec;
      if (!winner.profileId && loser.profileId) {
        winner.profileId = loser.profileId;
        winner.displayName = loser.displayName;
        winner.nameSource = loser.nameSource;
        winner.liveConfidence = loser.liveConfidence;
      }
      loser.mergedInto = winner.sessionSpeakerId;
      return;
    }
  }

  // ------------------------------------------------------- profile match

  /** `sessionSpeakerId`s eligible to try `speaker_profiles` matching this pass: sticky, unresolved, under the retry cap, not merged away. */
  candidatesForProfileMatch(): string[] {
    return [...this.byId.values()]
      .filter((s) => s.sticky && !s.profileId && s.profileAttempts < 5 && !s.mergedInto)
      .map((s) => s.sessionSpeakerId);
  }

  centroidFor(sessionSpeakerId: string): Float32Array | null {
    return this.byId.get(sessionSpeakerId)?.centroid ?? null;
  }

  applyProfileMatch(sessionSpeakerId: string, match: { profileId?: string; displayName?: string; confidence: number }): void {
    const speaker = this.byId.get(sessionSpeakerId);
    if (!speaker) return;
    speaker.profileAttempts += 1;
    if (match.profileId) {
      speaker.profileId = match.profileId;
      speaker.displayName = match.displayName;
      speaker.nameSource = 'live';
      speaker.liveConfidence = match.confidence;
    }
  }

  // -------------------------------------------------------- persistence

  /** Turns folded in since the last read — consumed (cleared) so `live-turns.json` never gets the same span appended twice. */
  settledTurns(): SettledTurn[] {
    const out = this.pendingSettled;
    this.pendingSettled = [];
    return out;
  }

  snapshot(): SessionSpeakerSnapshot[] {
    return [...this.byId.values()].map((s) => ({
      sessionSpeakerId: s.sessionSpeakerId,
      sonioxLabels: [...s.sonioxLabels],
      displayName: s.displayName,
      profileId: s.profileId,
      nameSource: s.nameSource,
      liveConfidence: s.liveConfidence,
      liveSpeechSec: s.speechSec,
      colorKey: s.colorKey,
      resolved: Boolean(s.profileId) || s.nameSource === 'user',
      mergedInto: s.mergedInto,
    }));
  }

  private computeHash(): string {
    const parts = this.snapshot()
      .map((s) => `${s.sessionSpeakerId}:${s.sonioxLabels.join(',')}:${s.profileId ?? ''}:${s.displayName ?? ''}:${Math.round(s.liveSpeechSec)}:${s.mergedInto ?? ''}`)
      .sort()
      .join('|');
    return fnv1aHex(parts);
  }

  /** True when the snapshot changed since the last `markPersisted()` — gates App DB writes to at most once per part (S2-14). */
  snapshotChanged(): boolean {
    return this.computeHash() !== this.lastPersistedHash;
  }

  snapshotHash(): string {
    return this.computeHash();
  }

  /** Call after a successful `live-speaker-repository.upsertAll` — resets the change-gate. */
  markPersisted(): void {
    this.lastPersistedHash = this.computeHash();
  }

  /** Rebuilds state from `meeting_speakers` rows after a restart/eviction (`loadForMeeting`). Restored session speakers are treated as already-sticky and already profile-attempted-if-resolved: their `liveSpeechSec` already cleared the sticky bar before the restart, and re-running profile matching on an already-linked speaker would be wasted work. */
  loadFrom(rows: readonly LoadableSpeakerRow[]): void {
    for (const row of rows) {
      if (!row.sessionSpeakerId || this.byId.has(row.sessionSpeakerId)) continue;
      const speaker: SessionSpeaker = {
        sessionSpeakerId: row.sessionSpeakerId,
        sonioxLabels: [...row.sonioxLabels],
        centroid: row.centroid,
        embeddings: row.centroid ? [row.centroid] : [],
        speechSec: row.liveSpeechSec,
        turnCount: 2,
        sticky: true,
        profileId: row.profileId,
        displayName: row.displayName,
        nameSource: row.nameSource,
        liveConfidence: row.liveConfidence,
        profileAttempts: row.profileId ? 5 : 0,
        colorKey: row.colorKey || this.nextColor(),
      };
      this.byId.set(speaker.sessionSpeakerId, speaker);
      for (const label of speaker.sonioxLabels) this.byLabel.set(label, speaker);
    }
    // A freshly rebuilt registry already matches what App DB has — do not
    // immediately re-write it on the very next chunk with identical data.
    this.lastPersistedHash = this.computeHash();
  }
}

/** Registry-of-registries: TTL (idle 30min) + LRU eviction capped at `LIVE_MAX_CONCURRENT_RECORDINGS` (S2-13) — a full cap evicts the LEAST recently touched meeting rather than rejecting a new one. */
export class SessionRegistryStore {
  private readonly registries = new Map<string, MeetingSessionRegistry>();

  constructor(private readonly maxConcurrent: number = env.liveMaxConcurrentRecordings) {}

  has(meetingId: string): boolean {
    return this.registries.has(meetingId);
  }

  /** Get-or-create. Newly created registries are EMPTY — the caller (`live-speaker-repository.ensureRegistry`) is responsible for calling `loadFrom` right after when `has()` was false. */
  get(meetingId: string): MeetingSessionRegistry {
    this.sweepIdle();
    let registry = this.registries.get(meetingId);
    if (registry) {
      // Touch for LRU: re-insert so Map's insertion order keeps this the most recent.
      this.registries.delete(meetingId);
      this.registries.set(meetingId, registry);
      return registry;
    }
    if (this.registries.size >= this.maxConcurrent) this.evictLru();
    registry = new MeetingSessionRegistry(meetingId);
    this.registries.set(meetingId, registry);
    return registry;
  }

  private sweepIdle(): void {
    const cutoff = Date.now() - REGISTRY_TTL_MS;
    for (const [meetingId, registry] of this.registries) {
      if (registry.lastActivityAt < cutoff) this.registries.delete(meetingId);
    }
  }

  private evictLru(): void {
    const oldest = this.registries.keys().next().value;
    if (oldest !== undefined) this.registries.delete(oldest);
  }
}

/** One process-wide store — every meeting's live registry lives here. */
export const sessionRegistries = new SessionRegistryStore();
