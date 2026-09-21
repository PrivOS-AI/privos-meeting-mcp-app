/**
 * One session speaker's centroid construction — split out of
 * `session-speaker-registry.ts` so the anchor/recent bookkeeping is
 * unit-testable without a whole registry (phase file: "a small
 * struct/class"). Pure math, no I/O; the registry decides ASSIGN (which
 * speaker a turn belongs to) and the UPDATE/duration gates (whether an
 * embedding may reach this module at all) — this class only decides, for an
 * embedding that already cleared those gates, whether it becomes a pinned
 * ANCHOR, joins the rolling RECENT window, or is rejected as slow drift
 * (`SPEAKER_SESSION_CENTROID_MODE=anchors` only), and recomputes the
 * centroid.
 *
 * Two modes, selected once at construction (`env.speakerSessionCentroidMode`):
 *  - `fifo` (today's behaviour): every embedding that reaches this module
 *    joins one FIFO window (cap 10, oldest evicted), plain (unweighted) mean.
 *    No anchors are ever pinned; the anchor-drift check never runs.
 *  - `anchors`: up to 5 pinned anchors (the first embeddings that qualified
 *    by duration and were never evicted) plus a rolling window of 10 recent,
 *    duration-weighted mean over anchors ∪ recent. An embedding that does not
 *    qualify as a new anchor must ALSO clear `updateThreshold` against the
 *    ANCHOR-ONLY centroid to enter `recent` — this is what stops slow drift
 *    that the overall centroid alone would not catch.
 */
import { cosineSimilarity } from '../../shared/cosine.js';
import type { SessionCentroidMode } from '../env.js';

export type UpdateAction = 'anchor' | 'recent' | 'rejected-low-cos' | 'rejected-short' | 'provisional';

export interface HeldEmbedding {
  vector: Float32Array;
  durSec: number;
}

/** Recent-window cap, both modes — same as today's FIFO cap (`EMBEDDING_CAP` in the registry, pre-split). */
export const RECENT_CAP = 10;
/** Anchor cap — "up to 5 pinned ANCHORS" (phase file). */
export const ANCHOR_CAP = 5;
/** An embedding must be at least this long to ever become an anchor — "first embeddings that passed UPDATE with duration >= 4s" (phase file); not env-configurable, an architectural constant of the anchors mode. */
export const ANCHOR_MIN_DURATION_SEC = 4;

/** `cosineSimilarity` without its length-mismatch throw — mirrors `session-speaker-registry.ts`'s `safeCosine` (kept local so this module has no dependency on the registry). */
function safeCosine(a: Float32Array, b: Float32Array): number {
  return a.length === b.length ? cosineSimilarity(a, b) : 0;
}

function plainMean(vectors: readonly Float32Array[]): Float32Array {
  const dim = vectors[0].length;
  const out = new Float32Array(dim);
  for (const v of vectors) {
    if (v.length !== dim) continue;
    for (let i = 0; i < dim; i++) out[i] += v[i];
  }
  for (let i = 0; i < dim; i++) out[i] /= vectors.length;
  return out;
}

/** Duration-weighted mean — `anchors` mode's centroid construction. A near-zero floor on the weight keeps a pathological `durSec<=0` sample from zeroing out the whole average. */
function weightedMean(held: readonly HeldEmbedding[]): Float32Array {
  const dim = held[0].vector.length;
  const out = new Float32Array(dim);
  let totalWeight = 0;
  for (const h of held) totalWeight += Math.max(h.durSec, 0.001);
  for (const h of held) {
    const w = Math.max(h.durSec, 0.001) / totalWeight;
    for (let i = 0; i < dim; i++) out[i] += h.vector[i] * w;
  }
  return out;
}

export class SessionSpeakerCentroid {
  private anchorList: HeldEmbedding[] = [];
  private recentList: HeldEmbedding[] = [];
  private centroidValue: Float32Array | null = null;

  constructor(private readonly mode: SessionCentroidMode) {}

  get anchors(): readonly HeldEmbedding[] {
    return this.anchorList;
  }

  get recent(): readonly HeldEmbedding[] {
    return this.recentList;
  }

  get centroid(): Float32Array | null {
    return this.centroidValue;
  }

  /** Nothing has ever been folded into this centroid yet — the caller's cue that the NEXT `add()` is the brand-new-speaker exemption. */
  get isEmpty(): boolean {
    return this.anchorList.length === 0 && this.recentList.length === 0;
  }

  /** True once at least one embedding is held but no real anchor has replaced the provisional seed yet (`anchors` mode only — always `false` under `fifo`, which never pins anchors at all). */
  get isProvisional(): boolean {
    return this.mode === 'anchors' && this.anchorList.length === 0 && this.recentList.length > 0;
  }

  /** Every vector currently backing the centroid (anchors ∪ recent) — the `max` score mode's candidate set, and what `recompute()` folds over. */
  heldVectors(): Float32Array[] {
    return [...this.anchorList, ...this.recentList].map((h) => h.vector);
  }

  private anchorCentroid(): Float32Array | null {
    return this.anchorList.length > 0 ? weightedMean(this.anchorList) : null;
  }

  private recompute(): void {
    const held = [...this.anchorList, ...this.recentList];
    if (held.length === 0) {
      this.centroidValue = null;
      return;
    }
    this.centroidValue = this.mode === 'anchors' ? weightedMean(held) : plainMean(held.map((h) => h.vector));
  }

  private pushRecent(entry: HeldEmbedding): void {
    this.recentList.push(entry);
    if (this.recentList.length > RECENT_CAP) this.recentList.shift();
  }

  /**
   * Folds one embedding that the CALLER already decided may update the
   * centroid — the brand-new-speaker exemption, or a turn that cleared both
   * the duration gate and the UPDATE threshold against this speaker's overall
   * score. Returns the classification for diagnostics
   * (`ObserveFact.updateAction`); `rejected-low-cos` here is specifically the
   * `anchors`-mode anchor-drift check (a SEPARATE, stricter gate than the
   * caller's own UPDATE check — comparing against the anchor-only centroid).
   */
  add(embedding: Float32Array, durSec: number, opts: { updateThreshold: number }): UpdateAction {
    if (this.isEmpty) {
      // Brand-new speaker's first-ever embedding — nothing to compare against
      // yet. Held as the provisional seed (kept in `recent` under both modes:
      // under `fifo` there is no structural distinction from any other held
      // embedding; under `anchors` it is superseded the moment a real anchor
      // qualifies, see below).
      this.pushRecent({ vector: embedding, durSec });
      this.recompute();
      return 'provisional';
    }

    if (this.mode === 'fifo') {
      this.pushRecent({ vector: embedding, durSec });
      this.recompute();
      return 'recent';
    }

    // `anchors` mode from here.
    const qualifiesAsAnchor = durSec >= ANCHOR_MIN_DURATION_SEC && this.anchorList.length < ANCHOR_CAP;
    if (qualifiesAsAnchor) {
      if (this.anchorList.length === 0) this.recentList = []; // the provisional seed is replaced by the first anchor-quality embedding
      this.anchorList.push({ vector: embedding, durSec });
      this.recompute();
      return 'anchor';
    }

    const anchorCentroid = this.anchorCentroid();
    if (anchorCentroid && safeCosine(embedding, anchorCentroid) < opts.updateThreshold) {
      // Stops slow drift: scores fine against the (already drifting) overall
      // centroid but not against the pinned anchors — never enters `recent`.
      return 'rejected-low-cos';
    }

    this.pushRecent({ vector: embedding, durSec });
    this.recompute();
    return 'recent';
  }

  /**
   * Combines `other` INTO this centroid (the merge winner absorbs the loser) —
   * anchors: union capped at `ANCHOR_CAP` by LONGEST duration; recent: the two
   * FIFO windows concatenated (this speaker's own, then `other`'s — matching
   * `performMerge`'s pre-split `[...winner.embeddings, ...loser.embeddings]`
   * order) and capped at `RECENT_CAP`, keeping the most recently added. Under
   * `fifo` mode `anchorList` is always empty on both sides, so this reduces
   * exactly to the pre-split concat-then-cap-then-mean behaviour.
   */
  absorb(other: SessionSpeakerCentroid): void {
    this.anchorList = [...this.anchorList, ...other.anchorList]
      .sort((a, b) => b.durSec - a.durSec)
      .slice(0, ANCHOR_CAP);
    this.recentList = [...this.recentList, ...other.recentList].slice(-RECENT_CAP);
    this.recompute();
  }

  /**
   * Rebuilds from a single restored centroid vector (`meeting_speakers.pendingEmbedding`
   * after decrypt) — persistence never stores anchors/recent separately (no
   * schema change), so a restart folds the whole prior state into ONE anchor
   * (phase file: "after restart the restored centroid becomes a single
   * anchor"). `durSec` is the row's accumulated `liveSpeechSec` — the anchor's
   * weight is whatever speech backed it before the restart.
   */
  static fromRestoredCentroid(mode: SessionCentroidMode, vector: Float32Array, durSec: number): SessionSpeakerCentroid {
    const state = new SessionSpeakerCentroid(mode);
    // `anchors` mode: a real pinned anchor, per the phase contract. `fifo`
    // mode has no anchor concept — placing it in `recent` instead keeps it
    // subject to the normal cap-10 eviction as more turns arrive, matching
    // the pre-split behaviour (`embeddings: [row.centroid]`, FIFO from there).
    if (mode === 'anchors') state.anchorList = [{ vector, durSec }];
    else state.recentList = [{ vector, durSec }];
    state.recompute();
    return state;
  }
}
