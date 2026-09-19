/**
 * The `embed` step `meeting-job.ts` calls after segmentation: for every
 * `speakerId` from the async pass, picks clean ranges (`segment-picker.ts`),
 * embeds them, matches against every `speaker_profiles` embedding
 * (`speaker-matcher.ts`), and either auto-enrols (match + coherent cluster)
 * or parks a sealed embedding in `meeting_speakers.pendingEmbedding` for
 * later confirmation via `speaker_resolve`.
 *
 * Cluster-coherence gate (plan.md § Requirements + risk table "block
 * automatic enrolment"): a diarization turn that actually blends two voices produces an
 * embedding that can spuriously score close to a real profile. Rather than
 * embedding once from the concatenated PCM of all picked ranges (which would
 * hide exactly this failure mode), this module embeds EACH range
 * separately and requires `minPairwiseCosine >= threshold` across them
 * before the (range-averaged) representative embedding is trusted enough to
 * auto-enrol. A cluster that fails this check still contributes NOTHING to
 * `speaker_profiles` — it is treated the same as "no match", parked as
 * `pendingEmbedding` (envelope carries the coherence score so
 * `speaker-resolve-tool.ts` does not have to re-embed from audio that may no
 * longer exist by the time a human confirms it).
 */
import { readWavPcm } from '../media/decode-audio.js';
import { getSetting } from '../hub/app-settings.js';
import { env } from '../env.js';
import type { AppDbBotClient } from '../hub/app-db-bot-client.js';
import { computeEmbedding } from './embedding-extractor.js';
import { hasSpeechEnergy } from './pcm-utils.js';
import * as profileStore from './profile-store.js';
import { planEnrolment, type EnrolRange } from './segment-picker.js';
import { matchSpeaker } from './speaker-matcher.js';
import { openEmbedding, sealEmbedding, type SealedEmbedding } from './voiceprint-crypto.js';
import type { Segment } from '../transcript/segment-builder.js';

export interface ResolvedSpeaker {
  speakerId: string;
  totalSpeakSec: number;
  sampleSec: number;
  sampleRange?: { startSec: number; endSec: number };
  profileId?: string;
  displayName?: string;
  confidence?: number;
  resolved: boolean;
  /** Sealed ciphertext (never a raw vector) — written to `meeting_speakers.pendingEmbedding` by the caller when present. */
  pendingEmbeddingJson?: string;
}

/** `meeting_speakers.pendingEmbedding` envelope — a sealed embedding plus the coherence metadata computed once at embed time, so a later `speaker_resolve` never needs to re-derive it from audio. */
export interface PendingEmbeddingEnvelope extends SealedEmbedding {
  minPairwiseCosine: number;
  rangeCount: number;
  durationSec: number;
}

export function sealPendingEmbedding(vector: Float32Array, meta: { profileId: string; minPairwiseCosine: number; rangeCount: number; durationSec: number }): string {
  const sealed = sealEmbedding(vector, { profileId: meta.profileId, createdAt: new Date().toISOString() });
  const envelope: PendingEmbeddingEnvelope = { ...sealed, minPairwiseCosine: meta.minPairwiseCosine, rangeCount: meta.rangeCount, durationSec: meta.durationSec };
  return JSON.stringify(envelope);
}

/** Opens a `pendingEmbedding` string back into its vector + coherence metadata, or `null` on any parse/HMAC/decrypt failure (never throws — same contract as `voiceprint-crypto.openEmbedding`). */
export function openPendingEmbedding(json: string): { vector: Float32Array; minPairwiseCosine: number; rangeCount: number; durationSec: number } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const envelope = parsed as Partial<PendingEmbeddingEnvelope>;
  if (typeof envelope.ct !== 'string' || typeof envelope.minPairwiseCosine !== 'number') return null;
  const vector = openEmbedding(envelope as SealedEmbedding);
  if (!vector) return null;
  return {
    vector,
    minPairwiseCosine: envelope.minPairwiseCosine,
    rangeCount: typeof envelope.rangeCount === 'number' ? envelope.rangeCount : 1,
    durationSec: typeof envelope.durationSec === 'number' ? envelope.durationSec : 0,
  };
}

/** Cosine of two same-length vectors without `cosineSimilarity`'s length-mismatch throw — callers here already skip mismatched pairs. */
function cosineUnsafe(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

/** The minimum pairwise cosine across a set of per-range embeddings — 1 (trivially coherent) when there is only one range. */
function minPairwiseCosine(vectors: readonly Float32Array[]): number {
  if (vectors.length < 2) return 1;
  let min = 1;
  for (let i = 0; i < vectors.length; i++) {
    for (let j = i + 1; j < vectors.length; j++) {
      if (vectors[i].length !== vectors[j].length) continue;
      min = Math.min(min, cosineUnsafe(vectors[i], vectors[j]));
    }
  }
  return min;
}

function averageVectors(vectors: readonly Float32Array[]): Float32Array {
  const dim = vectors[0].length;
  const out = new Float32Array(dim);
  let count = 0;
  for (const v of vectors) {
    if (v.length !== dim) continue;
    for (let i = 0; i < dim; i++) out[i] += v[i];
    count += 1;
  }
  if (count > 0) for (let i = 0; i < dim; i++) out[i] /= count;
  return out;
}

/** `app_settings.speakerMatchThreshold` (admin-tunable) with the env default as fallback — shared by the automatic embed pass and `speaker_resolve`'s manual coherence check, so both use the SAME bar. */
export async function readMatchThreshold(db: AppDbBotClient): Promise<number> {
  const stored = await getSetting<number>(db, 'speakerMatchThreshold');
  return typeof stored === 'number' && stored > 0 && stored < 1 ? stored : env.speakerMatchThreshold;
}

async function embedRanges(wavPath: string, ranges: readonly EnrolRange[]): Promise<Float32Array[]> {
  const embeddings: Float32Array[] = [];
  for (const range of ranges) {
    const pcm = await readWavPcm(wavPath, range.startSec, range.endSec);
    if (!hasSpeechEnergy(pcm)) continue;
    embeddings.push(await computeEmbedding(pcm));
  }
  return embeddings;
}

/**
 * Runs the embed+match+enrol pass for every speaker in `segments`, against
 * `wavPath` (the job's decoded 16k mono wav). NEVER returns a vector — every
 * `ResolvedSpeaker` field is display-safe (plan.md's "no embedding in any MCP
 * response" invariant, enforced by construction here rather than trusted at
 * the tool boundary).
 */
export async function resolveSpeakers(db: AppDbBotClient, wavPath: string, segments: readonly Segment[], meetingId: string): Promise<ResolvedSpeaker[]> {
  const threshold = await readMatchThreshold(db);
  const profiles = await profileStore.listProfiles(db);
  const plans = planEnrolment(segments, { minSegSec: env.speakerMinSegmentSec, targetSec: env.speakerEnrolTargetSec });

  const out: ResolvedSpeaker[] = [];

  for (const plan of plans) {
    if (plan.ranges.length === 0) {
      out.push({ speakerId: plan.speakerId, totalSpeakSec: plan.totalSpeakSec, sampleSec: 0, resolved: false });
      continue;
    }

    const rangeEmbeddings = await embedRanges(wavPath, plan.ranges);
    if (rangeEmbeddings.length === 0) {
      // Every picked range turned out to be near-silent once actually read from the wav — same "too little data" outcome as an empty plan.
      out.push({ speakerId: plan.speakerId, totalSpeakSec: plan.totalSpeakSec, sampleSec: 0, resolved: false });
      continue;
    }

    const coherence = minPairwiseCosine(rangeEmbeddings);
    const coherent = coherence >= threshold;
    const representative = averageVectors(rangeEmbeddings);
    const sampleRange = plan.ranges[0];

    if (!coherent) {
      // Bimodal cluster (likely two voices in one diarization turn) — never
      // auto-enrol AND never auto-label from a match, however close it
      // scores: the representative vector itself is untrustworthy. Park it
      // so a human can resolve it via `speaker_resolve` (which will see the
      // same `minPairwiseCosine` and offer "not the same person").
      const pendingEmbeddingJson = sealPendingEmbedding(representative, {
        profileId: `pending:${meetingId}:${plan.speakerId}`,
        minPairwiseCosine: coherence,
        rangeCount: rangeEmbeddings.length,
        durationSec: plan.totalSec,
      });
      out.push({ speakerId: plan.speakerId, totalSpeakSec: plan.totalSpeakSec, sampleSec: plan.totalSec, sampleRange, resolved: false, pendingEmbeddingJson });
      continue;
    }

    const match = matchSpeaker(representative, profiles, threshold);
    if (match.profileId) {
      await profileStore.enrolEmbedding(db, match.profileId, { vector: representative, meetingId, durationSec: plan.totalSec });
      out.push({
        speakerId: plan.speakerId,
        totalSpeakSec: plan.totalSpeakSec,
        sampleSec: plan.totalSec,
        sampleRange,
        profileId: match.profileId,
        displayName: match.displayName,
        confidence: match.confidence,
        resolved: true,
      });
      continue;
    }

    // Coherent cluster, no profile match — park for `speaker_resolve` (no `cluster_not_coherent` flag; coherence itself is fine, it just doesn't match anyone yet).
    const pendingEmbeddingJson = sealPendingEmbedding(representative, {
      profileId: `pending:${meetingId}:${plan.speakerId}`,
      minPairwiseCosine: coherence,
      rangeCount: rangeEmbeddings.length,
      durationSec: plan.totalSec,
    });
    out.push({
      speakerId: plan.speakerId,
      totalSpeakSec: plan.totalSpeakSec,
      sampleSec: plan.totalSec,
      sampleRange,
      confidence: match.confidence,
      resolved: false,
      pendingEmbeddingJson,
    });
  }

  return out;
}
