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
import { logEvent } from './speaker-diagnostics-log.js';
import { matchSpeaker } from './speaker-matcher.js';
import { openEmbeddingWithMeta, sealEmbeddingWithMeta, openEmbedding, type SealedEmbedding } from './voiceprint-crypto.js';
import type { Segment } from '../transcript/segment-builder.js';

/** A user identity carried into this pass from a live-named speaker (`meeting-job.ts`'s `computeAsyncToLiveMap`) — skips matching/auto-enrol entirely; the identified speaker's coherent representative enrols straight into this profile as `user-post`. */
export interface UserIdentity {
  displayName: string;
  privosUserId?: string;
  profileId?: string;
  createdByUserId: string;
  createdInRoomId?: string;
}

export interface ResolvedSpeaker {
  speakerId: string;
  totalSpeakSec: number;
  sampleSec: number;
  sampleRange?: { startSec: number; endSec: number };
  profileId?: string;
  displayName?: string;
  confidence?: number;
  resolved: boolean;
  /** Set to `'user'` when this speaker's identity came from `userIdentityBySpeakerId` (a live-named speaker carried into this pass) — the caller (`meeting-job.ts`) writes it verbatim instead of its own `resolved ? 'async' : undefined` default. */
  nameSource?: 'user';
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
  const sealed = sealEmbeddingWithMeta(
    vector,
    { profileId: meta.profileId, createdAt: new Date().toISOString() },
    { minPairwiseCosine: meta.minPairwiseCosine, rangeCount: meta.rangeCount, durationSec: meta.durationSec },
  );
  return JSON.stringify(sealed);
}

/**
 * Opens a `pendingEmbedding` string back into its vector + coherence
 * metadata, asserting it belongs to `expectedProfileId`
 * (`live:<meetingId>:<sessionSpeakerId>` / `pending:<meetingId>:<speakerId>`
 * — the caller derives this from the ROW it read the JSON from, never from
 * the JSON itself). Returns `null` on any parse/binding/HMAC/decrypt
 * failure (never throws).
 *
 * Tries the current sealed-meta shape first (meta MAC-covered, inside the
 * payload); falls back to the legacy POST-MEETING shape (meta as plain
 * sibling JSON keys OUTSIDE the sealed payload, still binding-checked and
 * HMAC-verified) so an envelope parked before this deploy stays enrolable.
 * An OLD-shape LIVE row (plain `sealEmbedding`, no coherence meta at all —
 * pre-phase-3 production output) matches neither shape and returns `null`.
 */
export function openPendingEmbedding(json: string, expectedProfileId: string): { vector: Float32Array; minPairwiseCosine: number; rangeCount: number; durationSec: number } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const sealed = parsed as Partial<SealedEmbedding>;
  if (typeof sealed.ct !== 'string' || typeof sealed.profileId !== 'string') return null;

  const withMeta = openEmbeddingWithMeta<Partial<{ minPairwiseCosine: number; rangeCount: number; durationSec: number }>>(sealed as SealedEmbedding, expectedProfileId);
  if (withMeta && typeof withMeta.meta.minPairwiseCosine === 'number') {
    return {
      vector: withMeta.vector,
      minPairwiseCosine: withMeta.meta.minPairwiseCosine,
      rangeCount: typeof withMeta.meta.rangeCount === 'number' ? withMeta.meta.rangeCount : 1,
      durationSec: typeof withMeta.meta.durationSec === 'number' ? withMeta.meta.durationSec : 0,
    };
  }

  // Legacy POST-MEETING shape: meta sits outside the sealed payload.
  const legacy = parsed as Partial<PendingEmbeddingEnvelope>;
  if (typeof legacy.minPairwiseCosine !== 'number' || legacy.profileId !== expectedProfileId) return null;
  const vector = openEmbedding(legacy as SealedEmbedding);
  if (!vector) return null;
  return {
    vector,
    minPairwiseCosine: legacy.minPairwiseCosine,
    rangeCount: typeof legacy.rangeCount === 'number' ? legacy.rangeCount : 1,
    durationSec: typeof legacy.durationSec === 'number' ? legacy.durationSec : 0,
  };
}

/** Historical post-meeting coherence rule, unchanged: a single picked range is trivially coherent (its own `minPairwiseCosine` is forced to 1 at seal time); two or more ranges must clear `threshold`. */
export function isPostMeetingCoherent(pending: { minPairwiseCosine: number; rangeCount: number }, threshold: number): boolean {
  return pending.rangeCount < 2 || pending.minPairwiseCosine >= threshold;
}

/**
 * The live one-shot enrolment bar (plan's "live path is ONE-SHOT" + "the live
 * bar applies to EVERY enrol path reading a live-sourced envelope"): a
 * single- or double-turn live centroid is NEVER trusted regardless of its
 * (trivially high) `minPairwiseCosine`, unlike the post-meeting rule above —
 * shared-mic live turns are short and noisy enough that real signal only
 * shows up over several independent turns. Uses its OWN coherence env value
 * (`SPEAKER_LIVE_ENROL_COHERENCE`), never `speakerMatchThreshold`.
 */
export function isLiveEnrolBarMet(pending: { minPairwiseCosine: number; rangeCount: number; durationSec: number }): boolean {
  return pending.rangeCount >= 3 && pending.durationSec >= env.liveEnrolMinSpeechSec && pending.minPairwiseCosine >= env.speakerLiveEnrolCoherence;
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
export async function resolveSpeakers(
  db: AppDbBotClient,
  wavPath: string,
  segments: readonly Segment[],
  meetingId: string,
  userIdentityBySpeakerId?: ReadonlyMap<string, UserIdentity>,
): Promise<ResolvedSpeaker[]> {
  const threshold = await readMatchThreshold(db);
  const profiles = await profileStore.listProfiles(db);
  const plans = planEnrolment(segments, { minSegSec: env.speakerMinSegmentSec, targetSec: env.speakerEnrolTargetSec });

  const out: ResolvedSpeaker[] = [];

  for (const plan of plans) {
    // A speaker already identified live (carried in by `meeting-job.ts` from a
    // `nameSource:'user'` live row with enough overlap) SKIPS matching
    // entirely — never guessed against, never at risk of landing in the
    // wrong auto-matched profile (plan.md finding #4).
    const userIdentity = userIdentityBySpeakerId?.get(plan.speakerId);

    if (plan.ranges.length === 0) {
      out.push({
        speakerId: plan.speakerId,
        totalSpeakSec: plan.totalSpeakSec,
        sampleSec: 0,
        resolved: Boolean(userIdentity),
        displayName: userIdentity?.displayName,
        nameSource: userIdentity ? 'user' : undefined,
      });
      continue;
    }

    const rangeEmbeddings = await embedRanges(wavPath, plan.ranges);
    if (rangeEmbeddings.length === 0) {
      // Every picked range turned out to be near-silent once actually read from the wav — same "too little data" outcome as an empty plan.
      out.push({
        speakerId: plan.speakerId,
        totalSpeakSec: plan.totalSpeakSec,
        sampleSec: 0,
        resolved: Boolean(userIdentity),
        displayName: userIdentity?.displayName,
        nameSource: userIdentity ? 'user' : undefined,
      });
      continue;
    }

    const coherence = minPairwiseCosine(rangeEmbeddings);
    const coherent = coherence >= threshold;
    const representative = averageVectors(rangeEmbeddings);
    const sampleRange = plan.ranges[0];

    if (userIdentity) {
      if (!coherent) {
        // Named already (the live identity), just not enrol-worthy yet — kept for a later confirmation, same as any other incoherent cluster.
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
          resolved: true,
          displayName: userIdentity.displayName,
          nameSource: 'user',
          pendingEmbeddingJson,
        });
        continue;
      }

      const enrolResult = await profileStore.findOrCreateProfileAndEnrol(db, userIdentity, representative, {
        meetingId,
        durationSec: plan.totalSec,
        source: 'user-post',
        speakerKey: plan.speakerId,
      });
      if (!enrolResult) {
        // The explicit merge target (mode 'merge', carried via `userIdentity.profileId`) vanished mid-job — still named, never silently dropped.
        out.push({ speakerId: plan.speakerId, totalSpeakSec: plan.totalSpeakSec, sampleSec: plan.totalSec, sampleRange, resolved: true, displayName: userIdentity.displayName, nameSource: 'user' });
        continue;
      }
      await logEvent(meetingId, {
        t: Date.now(),
        meetingId,
        type: 'enrol',
        profile: enrolResult.profile.id,
        source: 'user-post',
        coherence,
        durationSec: plan.totalSec,
        vectorCountAfter: enrolResult.vectorCountAfter,
      });
      out.push({
        speakerId: plan.speakerId,
        totalSpeakSec: plan.totalSpeakSec,
        sampleSec: plan.totalSec,
        sampleRange,
        profileId: enrolResult.profile.id,
        displayName: enrolResult.profile.displayName || userIdentity.displayName,
        confidence: 1,
        resolved: true,
        nameSource: 'user',
      });
      continue;
    }

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
    await logEvent(meetingId, {
      t: Date.now(),
      meetingId,
      type: 'profile-match',
      sessionSpeakerId: plan.speakerId,
      attempt: 1,
      best: match.bestProfileId ? { profile: match.bestProfileId, cos: match.confidence } : null,
      second: match.runnerUpProfileId ? { profile: match.runnerUpProfileId, cos: match.runnerUpConfidence } : null,
      threshold,
      accepted: Boolean(match.profileId),
    });
    if (match.profileId) {
      const vectorCountAfter = await profileStore.enrolEmbedding(db, match.profileId, {
        vector: representative,
        meetingId,
        durationSec: plan.totalSec,
        source: 'auto-post',
        speakerKey: plan.speakerId,
      });
      await logEvent(meetingId, {
        t: Date.now(),
        meetingId,
        type: 'enrol',
        profile: match.profileId,
        source: 'auto-post',
        coherence,
        durationSec: plan.totalSec,
        vectorCountAfter,
      });
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
