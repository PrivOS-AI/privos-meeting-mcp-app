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
import { env, type SessionScoreMode } from '../env.js';
import { canMerge, identityOutranks, isExplicitMergeRequest, mergePairKey, nextMergeStreak, type MergeBlockReason, type MergeCandidate, type MergeStreakEntry } from './session-speaker-merge-policy.js';
import { SessionSpeakerCentroid, type UpdateAction } from './session-speaker-centroid.js';
import { configFromEnv, type SpeakerThresholds } from './speaker-thresholds.js';

const PALETTE = ['blue', 'gold', 'green', 'purple', 'coral', 'teal'] as const;
/** Idle-registry eviction (S2-13) — no chunk processed for this long -> the registry-of-registries drops the meeting entirely. */
export const REGISTRY_TTL_MS = 30 * 60 * 1000;
/**
 * Profile-match retry backoff (plan.md: "replace the hard attempt cap with
 * backoff by NEW speech; no cap") — a sticky, unresolved speaker becomes (or
 * again becomes) a profile-match candidate once it has gained this much
 * UPDATE-QUALITY speech (speech that actually cleared the centroid UPDATE
 * gate, `session-speaker-centroid.ts#UpdateAction` — never
 * `rejected-short`/`rejected-low-cos`) since its last attempt. No upper bound
 * on the number of attempts — a person who talks long enough eventually gets
 * re-checked against every profile named since.
 */
export const PROFILE_MATCH_RETRY_SPEECH_SEC = 15;

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
  /** The score the code actually decided on for `targetId` — the SAME score used for the ASSIGN decision (mode-dependent: max-over-held or cosine-to-centroid, `env.speakerSessionScoreMode`), reused for the UPDATE gate too. 0 for a brand-new speaker with nothing held yet. */
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
  /** Whether this embedding actually touched `targetId`'s centroid — see `session-speaker-centroid.ts#UpdateAction`. Independent of `action`: a turn can be `folded` (attributed to this speaker) yet `rejected-short`/`rejected-low-cos` (never reaches the centroid). */
  updateAction: UpdateAction;
}

/**
 * Diagnostics fact emitted by `maybeMerge` for EVERY pair whose centroids
 * cleared the merge threshold, whether or not the merge actually happened.
 * `blockedBy` is absent exactly when this check performed the merge.
 */
export interface MergeFact {
  kind: 'merge';
  winnerId: string;
  loserId: string;
  cos: number;
  /** Each side's OWN accumulated speech, just before the merge combined them (or as of this check, if blocked). */
  winnerSpeechSec: number;
  loserSpeechSec: number;
  winnerNamed: boolean;
  loserNamed: boolean;
  /** The sustained-evidence streak count as of this check (0 when blocked by `identity`/`min-speech`, which never touch the streak). */
  streak: number;
  /** Set when this pair cleared the merge threshold but did NOT merge; absent when it did. */
  blockedBy?: MergeBlockReason;
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
  privosUserId?: string;
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
  privosUserId?: string;
  liveConfidence?: number;
  colorKey?: string;
}

interface SessionSpeaker {
  sessionSpeakerId: string;
  sonioxLabels: string[];
  centroidState: SessionSpeakerCentroid;
  speechSec: number;
  turnCount: number;
  sticky: boolean;
  profileId?: string;
  displayName?: string;
  nameSource?: NameSource;
  privosUserId?: string;
  liveConfidence?: number;
  /** Diagnostics-only count of every `applyProfileMatch` call — no longer used to cap retries (see `PROFILE_MATCH_RETRY_SPEECH_SEC`). */
  profileAttempts: number;
  /** Update-quality speech accumulated so far (see `PROFILE_MATCH_RETRY_SPEECH_SEC`'s doc comment) — a strict subset of `speechSec`. */
  qualitySpeechSec: number;
  /** `qualitySpeechSec`'s value as of the last `applyProfileMatch` call — `0` before the first attempt. */
  qualitySpeechSecAtLastAttempt: number;
  colorKey: string;
  mergedInto?: string;
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

/**
 * The SAME score `observe` uses both to decide ASSIGN (which session speaker a
 * turn belongs to) and, when folded, whether it clears UPDATE (may change the
 * centroid) — session assignment's OWN scoring function, replacing the old
 * borrow of `speaker-matcher.ts#matchSpeaker` over "pseudo-profiles" so a
 * future change to real-profile matching cannot silently alter session
 * assignment (`env.speakerSessionScoreMode`, `SPEAKER_SESSION_SCORE_MODE`).
 *  - `max` (today): max cosine over `speaker`'s currently held embeddings
 *    (anchors ∪ recent) — reproduces `matchSpeaker`'s per-vector comparison.
 *  - `centroid`: cosine to `speaker`'s current centroid — systematically
 *    lower at the same threshold (mean pulls toward the average voice).
 * 0 when `speaker` has no centroid yet (nothing held).
 */
function scoreAgainstSessionSpeaker(embedding: Float32Array, speaker: SessionSpeaker, mode: SessionScoreMode): number {
  if (!speaker.centroidState.centroid) return 0;
  if (mode === 'centroid') return safeCosine(embedding, speaker.centroidState.centroid);
  return speaker.centroidState.heldVectors().reduce((max, held) => Math.max(max, safeCosine(embedding, held)), 0);
}

/** The minimum pairwise cosine across a set of held embeddings — 1 (trivially "coherent") when there are fewer than 2, same convention as `resolve-speakers.ts`'s post-meeting coherence score. */
function minPairwiseCosineOfHeld(vectors: readonly Float32Array[]): number {
  if (vectors.length < 2) return 1;
  let min = 1;
  for (let i = 0; i < vectors.length; i++) {
    for (let j = i + 1; j < vectors.length; j++) min = Math.min(min, safeCosine(vectors[i], vectors[j]));
  }
  return min;
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
  private lastPartStamp: { seq: number; partStartMs: number; durationMs: number } | null = null;
  /** Server `Date.now()` minus the client's emit stamp for this meeting's first validated part — `estimateUploadLagMs`'s anchor, `null` until set once. */
  private wallEpochAnchorMs: number | null = null;
  private discontinuous = false;
  private degradedFlag = false;
  private lastPersistedHash = '';
  private webmInitSegment: Buffer | null = null;
  /** Sustained-evidence bookkeeping per candidate pair (`session-speaker-merge-policy.ts#mergePairKey`) — memory-only, never persisted (a restart resets streaks, the safe direction: plan.md § Non-functional). */
  private readonly mergeStreaks = new Map<string, MergeStreakEntry>();

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

  /**
   * `thresholds` defaults to `configFromEnv()` (today's-behaviour, read fresh
   * on EACH construction — not bound at module load, so a test/tool mutating
   * `env` before `new MeetingSessionRegistry(id)` still sees its own values)
   * — the only injection seam this class needs. `scripts/replay-meeting-speakers.ts`
   * passes an explicit object built from a calibration run's candidate
   * numbers instead, so one process can replay many configurations against
   * the same kept audio without touching `env` or restarting.
   */
  constructor(
    public readonly meetingId: string,
    private readonly thresholds: SpeakerThresholds = configFromEnv(),
  ) {}

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
      centroidState: new SessionSpeakerCentroid(this.thresholds.sessionCentroidMode),
      speechSec: 0,
      turnCount: 0,
      sticky: false,
      profileAttempts: 0,
      qualitySpeechSec: 0,
      qualitySpeechSecAtLastAttempt: 0,
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

  /**
   * Last absolute per-part stamp (`seq`, `partStartMs`, `durationMs`) this
   * meeting accepted from a NEW client's `partStartMs` — `null` before any
   * such part, including right after a restart/eviction rebuilt this
   * registry from scratch (this tracking is in-memory only, never persisted;
   * a fresh registry validates its next part with no continuity requirement,
   * `span-validation.ts#validatePartStamp`'s restart-safe-by-construction
   * contract). Unrelated to `decodedSecBefore`'s cumulative fallback clock,
   * which keeps working unchanged for a meeting whose client never sends
   * `partStartMs` at all.
   */
  lastPartStampForValidation(): { seq: number; partStartMs: number; durationMs: number } | null {
    return this.lastPartStamp;
  }

  /** Records a stamp that already passed `validatePartStamp` — the anchor the NEXT part's continuity check compares against. */
  noteValidPartStamp(seq: number, partStartMs: number, durationMs: number): void {
    this.lastPartStamp = { seq, partStartMs, durationMs };
  }

  /**
   * Diagnostics-only estimate of `uploadLagMs` (server arrival time vs the
   * client's emit stamp). The first validated part for a meeting DEFINES the
   * wall-clock anchor (its own upload lag is assumed ~0 and folded into the
   * anchor rather than reported) — every later part compares its actual
   * server arrival against what that anchor predicts. A heuristic, not a
   * synced clock: never used for slicing/validation, only logged.
   */
  estimateUploadLagMs(arrivedAtMs: number, partStartMs: number, durationMs: number): number {
    const emitAtMs = partStartMs + durationMs;
    if (this.wallEpochAnchorMs === null) {
      this.wallEpochAnchorMs = arrivedAtMs - emitAtMs;
      return 0;
    }
    const expectedArrivedAtMs = this.wallEpochAnchorMs + emitAtMs;
    return arrivedAtMs - expectedArrivedAtMs;
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
          .filter((s) => !s.mergedInto && s.centroidState.centroid)
          .map((s) => ({
            id: s.sessionSpeakerId,
            cosCentroid: safeCosine(embedding, s.centroidState.centroid!),
            cosMaxHeld: s.centroidState.heldVectors().reduce((max, held) => Math.max(max, safeCosine(embedding, held)), 0),
          }))
      : [];

    const scoreMode = this.thresholds.sessionScoreMode;
    let target = this.byLabel.get(label);
    let reinstanced = false;
    /** The ASSIGN score that actually decided this turn's target — reused below for the UPDATE gate (same score, same comparison, per plan.md: "the code actually decided on"). `undefined` only for a brand-new speaker with nothing to score against. */
    let assignScore: number | undefined;

    if (target) {
      // Verify EVERY direct-label fold, sticky or not (today only checked once
      // sticky — a non-sticky label folded blindly, letting a foreign voice on
      // a just-recycled label silently contaminate a brand-new speaker).
      const score = scoreAgainstSessionSpeaker(embedding, target, scoreMode);
      if (score < this.thresholds.sessionMatchThreshold) {
        // The label was recycled for a different voice — detach it from its old
        // owner (whose centroid is left untouched) and open a fresh instance.
        this.byLabel.delete(label);
        label = nextInstanceLabel(label, new Set(target.sonioxLabels));
        target = undefined;
        reinstanced = true;
      } else {
        assignScore = score;
      }
    }

    let createdNew = false;
    if (!target) {
      const hit = this.bestSessionMatch(embedding, scoreMode);
      target = hit?.speaker;
      assignScore = hit?.score;
      if (!target) {
        target = this.createSessionSpeaker();
        createdNew = true;
      }
      if (!target.sonioxLabels.includes(label)) target.sonioxLabels.push(label);
      this.byLabel.set(label, target);
    }

    // UPDATE gate: a brand-new speaker's first-ever embedding is exempt
    // (nothing to compare against yet) but marked provisional; otherwise a
    // turn must clear BOTH the duration floor and the UPDATE threshold
    // (reusing `assignScore`, the same score that decided ASSIGN above) to
    // touch the centroid — a turn that fails either is still ATTRIBUTED to
    // `target` (counts as speech, shows in the UI), just never folds in.
    let updateAction: UpdateAction;
    if (target.centroidState.isEmpty) {
      updateAction = target.centroidState.add(embedding, durSec, { updateThreshold: this.thresholds.sessionUpdateThreshold });
    } else if (durSec < this.thresholds.updateMinSegmentSec) {
      updateAction = 'rejected-short';
    } else if ((assignScore ?? 0) < this.thresholds.sessionUpdateThreshold) {
      updateAction = 'rejected-low-cos';
    } else {
      updateAction = target.centroidState.add(embedding, durSec, { updateThreshold: this.thresholds.sessionUpdateThreshold });
    }

    target.speechSec += durSec;
    if (updateAction !== 'rejected-short' && updateAction !== 'rejected-low-cos') target.qualitySpeechSec += durSec;
    target.turnCount += 1;
    target.sticky = target.turnCount >= 2 && target.speechSec >= this.thresholds.liveMinSpeechSec;

    this.pendingSettled.push({ sessionSpeakerId: target.sessionSpeakerId, startMs: seg.startMs, endMs: seg.endMs, sonioxLabel: label });
    this.lastActivityAt = Date.now();

    if (onFact) {
      onFact({
        kind: 'observe',
        label,
        startMs: seg.startMs,
        endMs: seg.endMs,
        durSec,
        final: seg.final,
        targetId: target.sessionSpeakerId,
        decisionScore: assignScore ?? 0,
        scores,
        sticky: target.sticky,
        action: reinstanced ? 'reinstanced' : createdNew ? 'new' : 'folded',
        updateAction,
      });
    }

    this.maybeMerge(target, onFact);
  }

  /** Best-scoring OTHER session speaker clearing ASSIGN, or `undefined` — session assignment's OWN match, replacing the old borrow of `speaker-matcher.ts#matchSpeaker` over pseudo-profiles (plan.md: "so phase 7's matcher change cannot silently alter session assignment"). Mirrors `matchSpeaker`'s best-over-candidates behaviour exactly under `scoreMode:'max'`. */
  private bestSessionMatch(embedding: Float32Array, scoreMode: SessionScoreMode): { speaker: SessionSpeaker; score: number } | undefined {
    let best: { speaker: SessionSpeaker; score: number } | undefined;
    for (const speaker of this.byId.values()) {
      if (speaker.mergedInto) continue;
      const score = scoreAgainstSessionSpeaker(embedding, speaker, scoreMode);
      if (score >= this.thresholds.sessionMatchThreshold && (!best || score > best.score)) best = { speaker, score };
    }
    return best;
  }

  /** `SessionSpeaker` -> the narrow shape `session-speaker-merge-policy.ts` actually needs — never the full internal object. */
  private toMergeCandidate(speaker: SessionSpeaker): MergeCandidate {
    return {
      centroid: speaker.centroidState.centroid!,
      speechSec: speaker.speechSec,
      embeddingCount: speaker.centroidState.heldVectors().length,
      displayName: speaker.displayName,
      profileId: speaker.profileId,
      nameSource: speaker.nameSource,
    };
  }

  /** Builds the diagnostics fact for one evaluated pair — `blockedBy` set when this check did NOT merge. */
  private buildMergeFact(a: SessionSpeaker, b: SessionSpeaker, cos: number, streak: number, blockedBy?: MergeBlockReason): MergeFact {
    const [winner, loser] = a.speechSec >= b.speechSec ? [a, b] : [b, a];
    return {
      kind: 'merge',
      winnerId: winner.sessionSpeakerId,
      loserId: loser.sessionSpeakerId,
      cos,
      winnerSpeechSec: winner.speechSec,
      loserSpeechSec: loser.speechSec,
      winnerNamed: Boolean(winner.displayName || winner.profileId),
      loserNamed: Boolean(loser.displayName || loser.profileId),
      streak,
      blockedBy,
    };
  }

  /**
   * Folds `loser` into `winner` (by accumulated speech — ties keep `a`) and
   * marks `loser.mergedInto`. The name/profile/user-identity fields are
   * decided SEPARATELY by precedence (`identityOutranks`: user > profile/
   * live/async > none), regardless of which side won by speech — today a
   * named loser's identity was dropped whenever the speech-winner already had
   * any name at all.
   */
  private performMerge(a: SessionSpeaker, b: SessionSpeaker, cos: number, streak: number, onFact?: SpeakerRegistryFactListener): void {
    const [winner, loser] = a.speechSec >= b.speechSec ? [a, b] : [b, a];
    // Captured BEFORE combining — the diagnostics event records what each side brought to the merge, not the post-merge total.
    const winnerSpeechSecBeforeMerge = winner.speechSec;
    const loserSpeechSecBeforeMerge = loser.speechSec;
    const winnerNamed = Boolean(winner.displayName || winner.profileId);
    const loserNamed = Boolean(loser.displayName || loser.profileId);

    for (const label of loser.sonioxLabels) {
      if (!winner.sonioxLabels.includes(label)) winner.sonioxLabels.push(label);
      this.byLabel.set(label, winner);
    }
    winner.centroidState.absorb(loser.centroidState);
    winner.speechSec += loser.speechSec;
    winner.qualitySpeechSec += loser.qualitySpeechSec;
    winner.turnCount += loser.turnCount;
    winner.sticky = winner.turnCount >= 2 && winner.speechSec >= this.thresholds.liveMinSpeechSec;
    if (identityOutranks(loser, winner)) {
      winner.profileId = loser.profileId;
      winner.displayName = loser.displayName;
      winner.nameSource = loser.nameSource;
      winner.privosUserId = loser.privosUserId;
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
      streak,
    });
  }

  /**
   * After every centroid update, checks for convergence with another session
   * speaker; merges at most one pair per `observe()` call (the next call
   * re-checks, so a chain of merges resolves over a few turns rather than
   * needing recursion here). Three gates, in order: (1) `canMerge` — never
   * merge two speakers a human/voiceprint already told apart, and (once
   * enabled) require both sides to have spoken enough; (2) an explicit merge
   * request (same user-given name/profile on both sides) merges immediately;
   * (3) otherwise, `SPEAKER_SESSION_MERGE_STREAK` consecutive qualifying
   * checks are required (`nextMergeStreak`) — the neutral default of 1
   * reproduces today's single-shot-on-first-clear behaviour.
   */
  private maybeMerge(changed: SessionSpeaker, onFact?: SpeakerRegistryFactListener): void {
    const changedCentroid = changed.centroidState.centroid;
    if (!changedCentroid) return;
    for (const other of this.byId.values()) {
      const otherCentroid = other.centroidState.centroid;
      if (other === changed || other.mergedInto || !otherCentroid) continue;
      const cos = cosineSimilarity(changedCentroid, otherCentroid);
      const key = mergePairKey(changed.sessionSpeakerId, other.sessionSpeakerId);
      if (cos < this.thresholds.sessionMergeThreshold) {
        this.mergeStreaks.delete(key);
        continue;
      }

      const a = this.toMergeCandidate(changed);
      const b = this.toMergeCandidate(other);
      const guard = canMerge(a, b, { minSpeechSec: this.thresholds.sessionMergeMinSpeechSec });
      if (!guard.ok) {
        this.mergeStreaks.delete(key);
        onFact?.(this.buildMergeFact(changed, other, cos, 0, guard.blockedBy));
        continue;
      }

      const streakResult = isExplicitMergeRequest(a, b)
        ? { count: Math.max(1, this.thresholds.sessionMergeStreak), satisfied: true }
        : nextMergeStreak(this.mergeStreaks.get(key), cos, this.thresholds.sessionMergeThreshold, changedCentroid, otherCentroid, this.thresholds.sessionMergeStreak);

      if (!streakResult.satisfied) {
        this.mergeStreaks.set(key, { count: streakResult.count, lastCentroidA: changedCentroid, lastCentroidB: otherCentroid });
        onFact?.(this.buildMergeFact(changed, other, cos, streakResult.count, 'streak'));
        continue;
      }

      this.mergeStreaks.delete(key);
      this.performMerge(changed, other, cos, streakResult.count, onFact);
      return;
    }
  }

  // ------------------------------------------------------- profile match

  /**
   * `sessionSpeakerId`s eligible to try `speaker_profiles` matching this
   * pass: sticky, unresolved, not merged away, and has gained
   * `PROFILE_MATCH_RETRY_SPEECH_SEC` of update-quality speech since its last
   * attempt (or never attempted at all) — replaces the old hard "stop after 5
   * attempts" cap with backoff-by-new-speech and NO cap (plan.md).
   */
  candidatesForProfileMatch(): string[] {
    return [...this.byId.values()]
      .filter((s) => s.sticky && !s.profileId && !s.mergedInto && s.qualitySpeechSec - s.qualitySpeechSecAtLastAttempt >= PROFILE_MATCH_RETRY_SPEECH_SEC)
      .map((s) => s.sessionSpeakerId);
  }

  centroidFor(sessionSpeakerId: string): Float32Array | null {
    return this.byId.get(sessionSpeakerId)?.centroidState.centroid ?? null;
  }

  /**
   * Returns the speaker's `profileAttempts` count AFTER this attempt (0 if
   * `sessionSpeakerId` is unknown) — lets the caller stamp a `profile-match`
   * diagnostics event without a separate lookup. A speaker already carrying a
   * human-confirmed identity (`nameSource:'user'`, set by
   * {@link applyUserIdentity}) is a no-op here beyond bumping the attempt
   * counter — "user identity beats guesses" (plan.md § Requirements): a live
   * profile match must never overwrite a name/profile the user just gave.
   */
  applyProfileMatch(sessionSpeakerId: string, match: { profileId?: string; displayName?: string; confidence: number }): number {
    const speaker = this.byId.get(sessionSpeakerId);
    if (!speaker) return 0;
    speaker.profileAttempts += 1;
    // Snapshot NOW regardless of outcome — backoff resumes counting from this
    // attempt's speech total whether it matched, missed, or was a no-op
    // (`nameSource:'user'`), so a name-carrying speaker parked here forever
    // never re-accumulates a stale, pre-user-identity backoff window.
    speaker.qualitySpeechSecAtLastAttempt = speaker.qualitySpeechSec;
    if (speaker.nameSource === 'user') return speaker.profileAttempts;
    if (match.profileId) {
      speaker.profileId = match.profileId;
      speaker.displayName = match.displayName;
      speaker.nameSource = 'live';
      speaker.liveConfidence = match.confidence;
    }
    return speaker.profileAttempts;
  }

  /**
   * Applies a human-confirmed identity (`speaker_resolve`, every mode) to the
   * in-memory session speaker — the counterpart to the App DB row write the
   * caller does in the SAME queued task (plan.md § Requirements: "no
   * interleaving"). Sets `nameSource:'user'`, which both `applyProfileMatch`
   * above and the next `upsertAll` (its own no-downgrade rule) respect from
   * this point on. A no-op (returns `false`) when `sessionSpeakerId` is
   * unknown to this registry — the caller falls back to the DB-only write.
   */
  applyUserIdentity(sessionSpeakerId: string, identity: { displayName: string; privosUserId?: string; profileId?: string }): boolean {
    const speaker = this.byId.get(sessionSpeakerId);
    if (!speaker) return false;
    speaker.displayName = identity.displayName;
    speaker.nameSource = 'user';
    speaker.privosUserId = identity.privosUserId;
    if (identity.profileId) speaker.profileId = identity.profileId;
    return true;
  }

  /**
   * Coherence stats over this session speaker's CURRENTLY held embeddings
   * (anchors ∪ recent) — feeds `sealPendingEmbedding`'s meta at `upsertAll`
   * time so a live row's `pendingEmbedding` is a REAL envelope (root cause 1:
   * production used to seal a plain centroid with no coherence data at all,
   * so `speaker_resolve` could never enrol it). `null` when the speaker has no
   * centroid yet (nothing observed).
   */
  coherenceFor(sessionSpeakerId: string): { minPairwiseCosine: number; rangeCount: number; durationSec: number } | null {
    const speaker = this.byId.get(sessionSpeakerId);
    if (!speaker || !speaker.centroidState.centroid) return null;
    const held = speaker.centroidState.heldVectors();
    return {
      minPairwiseCosine: minPairwiseCosineOfHeld(held),
      rangeCount: held.length,
      durationSec: speaker.speechSec,
    };
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
      privosUserId: s.privosUserId,
      liveConfidence: s.liveConfidence,
      liveSpeechSec: s.speechSec,
      colorKey: s.colorKey,
      resolved: Boolean(s.profileId) || s.nameSource === 'user',
      mergedInto: s.mergedInto,
    }));
  }

  private computeHash(): string {
    const parts = this.snapshot()
      .map(
        (s) =>
          `${s.sessionSpeakerId}:${s.sonioxLabels.join(',')}:${s.profileId ?? ''}:${s.displayName ?? ''}:${s.nameSource ?? ''}:${s.privosUserId ?? ''}:${Math.round(s.liveSpeechSec)}:${s.mergedInto ?? ''}`,
      )
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

  /**
   * Call after a successful `live-speaker-repository.upsertAll`, passing the
   * hash of the snapshot it ACTUALLY WROTE (captured before its own DB
   * awaits) — never re-derived from whatever the registry looks like NOW.
   * Recomputing here would mark an unwritten mutation (e.g. a `speaker_resolve`
   * that landed mid-write, before this fix's queue serialization) as already
   * persisted, silently dropping it (plan.md red-team finding #5).
   */
  markPersisted(hash: string): void {
    this.lastPersistedHash = hash;
  }

  /** Rebuilds state from `meeting_speakers` rows after a restart/eviction (`loadForMeeting`). Restored session speakers are treated as already-sticky and already profile-attempted-if-resolved: their `liveSpeechSec` already cleared the sticky bar before the restart, and re-running profile matching on an already-linked speaker would be wasted work. */
  loadFrom(rows: readonly LoadableSpeakerRow[]): void {
    for (const row of rows) {
      if (!row.sessionSpeakerId || this.byId.has(row.sessionSpeakerId)) continue;
      const speaker: SessionSpeaker = {
        sessionSpeakerId: row.sessionSpeakerId,
        sonioxLabels: [...row.sonioxLabels],
        centroidState: row.centroid
          ? SessionSpeakerCentroid.fromRestoredCentroid(this.thresholds.sessionCentroidMode, row.centroid, row.liveSpeechSec)
          : new SessionSpeakerCentroid(this.thresholds.sessionCentroidMode),
        speechSec: row.liveSpeechSec,
        turnCount: 2,
        sticky: true,
        profileId: row.profileId,
        displayName: row.displayName,
        nameSource: row.nameSource,
        privosUserId: row.privosUserId,
        liveConfidence: row.liveConfidence,
        profileAttempts: row.profileId ? 5 : 0,
        // Restored speech is all we know about this speaker's history — treat
        // it as already-quality so an unresolved restored speaker is
        // immediately eligible again (not stuck waiting out a fresh
        // PROFILE_MATCH_RETRY_SPEECH_SEC window it never actually needed).
        qualitySpeechSec: row.liveSpeechSec,
        qualitySpeechSecAtLastAttempt: row.profileId ? row.liveSpeechSec : 0,
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

  /**
   * Explicit eviction — the post-meeting job calls this right before its
   * speaker steps (after `chunkQueue.abort(meetingId)`) so a still-draining
   * chunk cannot resurrect stale live rows mid-reconcile (plan.md § job
   * reordering). A no-op when the meeting has no registry.
   */
  delete(meetingId: string): void {
    this.registries.delete(meetingId);
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
