/**
 * In-memory (per `meetingId`) live speaker registry — P5's core state machine
 * (D-16/S2-05). A realtime provider's `speaker` label (`s{sessionIndex}:{n}`)
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

/**
 * Diagnostics fact emitted by `observe()` for the caller to timestamp/wrap
 * into a `speaker-diagnostics-log.ts` event and persist — the registry itself
 * never imports the diagnostics module (stays pure/I/O-free). `scores` is
 * every OTHER live-session-speaker candidate compared against, computed
 * BEFORE this embedding folds in.
 */
export interface ObserveFact {
  kind: 'observe';
  label: string;
  startMs: number;
  endMs: number;
  durSec: number;
  final: boolean;
  targetId: string;
  /** The score the code actually decided on for `targetId` (max over its held embeddings) — 0 for a brand-new speaker with nothing held yet. */
  decisionScore: number;
  scores: { id: string; cosCentroid: number; cosMaxHeld: number }[];
  /** Whether `targetId` is sticky AFTER this turn folded in. */
  sticky: boolean;
  /**
   * `folded`: this turn joined an existing session speaker (via direct label
   * ownership or matching). `new`: no existing speaker matched, one was
   * created. `reinstanced`: the label was just detected as recycled for a
   * different voice and re-pointed at a fresh instance suffix (`label@2`, …) —
   * takes priority over `new`/`folded` because the recycle event itself is the
   * diagnostically interesting moment, whichever way its embedding then lands.
   */
  action: 'folded' | 'new' | 'reinstanced';
}

/** Diagnostics fact emitted by `maybeMerge` when it actually merges two session speakers. */
export interface MergeFact {
  kind: 'merge';
  winnerId: string;
  loserId: string;
  cos: number;
  /** Each side's OWN accumulated speech, just before the merge combined them. */
  winnerSpeechSec: number;
  loserSpeechSec: number;
  winnerNamed: boolean;
  loserNamed: boolean;
}

export type SpeakerRegistryFact = ObserveFact | MergeFact;

/** Callback the registry invokes with a raw fact — never persists/imports anything itself (see `ObserveFact`). */
export type SpeakerRegistryFactListener = (fact: SpeakerRegistryFact) => void;

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

/** `cosineSimilarity` without its length-mismatch throw — diagnostics scoring compares against every live speaker, including one built from a since-swapped embedding model. */
function safeCosine(a: Float32Array, b: Float32Array): number {
  return a.length === b.length ? cosineSimilarity(a, b) : 0;
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
  private webmInitSegment: Buffer | null = null;

  /**
   * Diagnostics write buffer (`speaker-diagnostics-log.ts`'s `append`/`flush`)
   * — hangs off THIS registry instance, never a module-level map, so it dies
   * with the registry on TTL/LRU eviction (S2-13) instead of leaking. Kept as
   * an opaque bag here on purpose: this module never imports the diagnostics
   * event types, so it stays pure/I/O-free (plan.md's "the registry stays
   * pure" requirement).
   */
  private readonly diagnosticEvents: Record<string, unknown>[] = [];
  /** Per-meeting `profileId -> alias` (`p1`, `p2`, …) for the room-audience diagnostics copy — real `profileId`s never leave the node. */
  private readonly profileAliases = new Map<string, string>();

  /** Last time a chunk was processed (or the registry was created) — the TTL clock (S2-13). */
  lastActivityAt = Date.now();

  constructor(public readonly meetingId: string) {}

  // -------------------------------------------------------- webm header

  /**
   * The WebM init segment cached from part 0 — prepended to header-less parts
   * (`seq >= 1`) before decode (see `live-speakers/webm-init-segment.ts`). Not
   * persisted: after a restart/eviction mid-meeting the worker re-fetches part
   * 0 to repopulate it.
   */
  getWebmInitSegment(): Buffer | null {
    return this.webmInitSegment;
  }

  setWebmInitSegment(bytes: Buffer): void {
    this.webmInitSegment = bytes;
  }

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

  /** Turn straddling a part boundary (S2-03) — its audio is not fully decoded yet; retried on the NEXT chunk instead of being dropped. */
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
      console.warn('[session-speaker-registry] seq duplicate/behind the already-processed chunk — reusing the existing accumulated clock.', {
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

  /** The `seq` the next chunk is expected to carry (`lastProcessedSeq + 1`, `0` before any chunk ever ran) — diagnostics-only (`gap` event); never gates or rejects a chunk. */
  nextExpectedSeq(): number {
    return this.lastProcessedSeq + 1;
  }

  // ------------------------------------------------------- diagnostics

  /** Buffers one diagnostics event (opaque to this module — see the field comment). Never throws. */
  pushDiagnosticEvent(event: Record<string, unknown>): void {
    this.diagnosticEvents.push(event);
  }

  /** Drains every buffered diagnostics event since the last drain. */
  drainDiagnosticEvents(): Record<string, unknown>[] {
    return this.diagnosticEvents.splice(0, this.diagnosticEvents.length);
  }

  /** Stable per-meeting `p1`/`p2`/… alias for a real `profileId`, assigned on first use — the room-audience diagnostics copy never carries the real id. */
  aliasForProfile(profileId: string): string {
    let alias = this.profileAliases.get(profileId);
    if (!alias) {
      alias = `p${this.profileAliases.size + 1}`;
      this.profileAliases.set(profileId, alias);
    }
    return alias;
  }

  // ------------------------------------------------------------- observe

  /**
   * Verifies + folds one embedding into the session speaker currently bound
   * to `label`. Re-verifies from scratch every time — nothing is ever
   * trusted purely because the label matches (D-16). Deduplicates by
   * `(speaker, startMs)`: a turn already embedded (draft, then resent as
   * final) is a silent no-op.
   *
   * `onFact`, when given, is called with a diagnostics-only `ObserveFact`
   * (and, if a merge happens as a result, a `MergeFact` too) — purely
   * observational, computed from state this method already touches; it never
   * feeds back into any decision above.
   */
  observe(label: string, embedding: Float32Array, durSec: number, seg: ChunkSegment, onFact?: SpeakerRegistryFactListener): void {
    if (this.alreadyProcessed(seg)) return;
    this.markProcessed(seg);

    // Diagnostics-only: this embedding's score against every OTHER live
    // speaker, taken BEFORE it folds into whichever one wins below.
    const scores = onFact
      ? [...this.byId.values()]
          .filter((s) => !s.mergedInto && s.centroid)
          .map((s) => ({
            id: s.sessionSpeakerId,
            cosCentroid: safeCosine(embedding, s.centroid!),
            cosMaxHeld: s.embeddings.reduce((max, held) => Math.max(max, safeCosine(embedding, held)), 0),
          }))
      : [];

    let target = this.byLabel.get(label);
    let reinstanced = false;
    if (target && target.sticky && target.centroid && cosineSimilarity(embedding, target.centroid) < env.speakerSessionMatchThreshold) {
      // The label was recycled for a different voice — detach it from its old
      // owner (whose centroid is left untouched) and open a fresh instance.
      this.byLabel.delete(label);
      label = nextInstanceLabel(label, new Set(target.sonioxLabels));
      target = undefined;
      reinstanced = true;
    }

    let createdNew = false;
    if (!target) {
      const hit = matchSpeaker(embedding, this.asPseudoProfiles(), env.speakerSessionMatchThreshold);
      target = hit.profileId ? this.byId.get(hit.profileId) : undefined;
      if (!target) {
        target = this.createSessionSpeaker();
        createdNew = true;
      }
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

    if (onFact) {
      const decisionScore = scores.find((s) => s.id === target!.sessionSpeakerId)?.cosMaxHeld ?? 0;
      onFact({
        kind: 'observe',
        label,
        startMs: seg.startMs,
        endMs: seg.endMs,
        durSec,
        final: seg.final,
        targetId: target.sessionSpeakerId,
        decisionScore,
        scores,
        sticky: target.sticky,
        action: reinstanced ? 'reinstanced' : createdNew ? 'new' : 'folded',
      });
    }

    this.maybeMerge(target, onFact);
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
  private maybeMerge(changed: SessionSpeaker, onFact?: SpeakerRegistryFactListener): void {
    if (!changed.centroid) return;
    for (const other of this.byId.values()) {
      if (other === changed || other.mergedInto || !other.centroid) continue;
      const cos = cosineSimilarity(changed.centroid, other.centroid);
      if (cos < env.speakerSessionMergeThreshold) continue;

      const [winner, loser] = changed.speechSec >= other.speechSec ? [changed, other] : [other, changed];
      // Captured BEFORE combining — the diagnostics event records what each side brought to the merge, not the post-merge total.
      const winnerSpeechSecBeforeMerge = winner.speechSec;
      const loserSpeechSecBeforeMerge = loser.speechSec;
      const winnerNamed = Boolean(winner.displayName || winner.profileId);
      const loserNamed = Boolean(loser.displayName || loser.profileId);

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

      onFact?.({
        kind: 'merge',
        winnerId: winner.sessionSpeakerId,
        loserId: loser.sessionSpeakerId,
        cos,
        winnerSpeechSec: winnerSpeechSecBeforeMerge,
        loserSpeechSec: loserSpeechSecBeforeMerge,
        winnerNamed,
        loserNamed,
      });
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

  /** Returns the speaker's `profileAttempts` count AFTER this attempt (0 if `sessionSpeakerId` is unknown) — lets the caller stamp a `profile-match` diagnostics event without a separate lookup. */
  applyProfileMatch(sessionSpeakerId: string, match: { profileId?: string; displayName?: string; confidence: number }): number {
    const speaker = this.byId.get(sessionSpeakerId);
    if (!speaker) return 0;
    speaker.profileAttempts += 1;
    if (match.profileId) {
      speaker.profileId = match.profileId;
      speaker.displayName = match.displayName;
      speaker.nameSource = 'live';
      speaker.liveConfidence = match.confidence;
    }
    return speaker.profileAttempts;
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
