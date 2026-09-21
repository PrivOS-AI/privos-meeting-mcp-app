/**
 * Every speaker-identification gate/mode-switch phases 5-7 added to `env.ts`,
 * consolidated into ONE injectable config object — `MeetingSessionRegistry`
 * (and the profile-matching call sites' `acceptProfileMatch` helper below,
 * `speaker-matcher.ts`) take this instead of reading `env` inline at each of
 * the many gate sites. `configFromEnv()` builds today's-behaviour default
 * straight from the process-wide `env` singleton; `scripts/replay-meeting-speakers.ts`
 * builds a DIFFERENT one from a calibration run's chosen numbers with no env
 * mutation and no process restart, so one process can replay many
 * configurations against the same kept audio in a sweep.
 *
 * Split out of `env.ts` (already >150 lines of unrelated STT/job/summary
 * config) purely to keep this module focused on the speaker-identification
 * surface calibration actually tunes.
 */
import { type AppEnv, type SessionCentroidMode, type SessionScoreMode, env } from '../env.js';

export interface SpeakerThresholds {
  // ---- in-meeting (session) live speaker registry gates ----
  /** ASSIGN bar + the label-recycle re-verification check (`SPEAKER_SESSION_MATCH_THRESHOLD`). */
  sessionMatchThreshold: number;
  /** UPDATE bar — whether a folded embedding may change its session speaker's centroid at all (`SPEAKER_SESSION_UPDATE_THRESHOLD`). */
  sessionUpdateThreshold: number;
  /** Minimum turn duration (seconds) allowed to update a centroid (`SPEAKER_UPDATE_MIN_SEGMENT_SEC`). */
  updateMinSegmentSec: number;
  /** `max` (per-held-vector) vs `centroid` (mean) session-assignment scoring (`SPEAKER_SESSION_SCORE_MODE`). */
  sessionScoreMode: SessionScoreMode;
  /** `fifo` vs `anchors` centroid construction (`SPEAKER_SESSION_CENTROID_MODE`). */
  sessionCentroidMode: SessionCentroidMode;
  /** Centroid-convergence merge bar (`SPEAKER_SESSION_MERGE_THRESHOLD`). */
  sessionMergeThreshold: number;
  /** Consecutive qualifying checks required before a merge actually fires (`SPEAKER_SESSION_MERGE_STREAK`). */
  sessionMergeStreak: number;
  /** Both sides' accumulated speech (seconds) required before a merge is even considered; `0` disables the gate (`SPEAKER_SESSION_MERGE_MIN_SPEECH_SEC`). */
  sessionMergeMinSpeechSec: number;
  /** Turns (>=2) + speech required before a session speaker's label link is trusted as "sticky" (`LIVE_MIN_SPEECH_SEC`). */
  liveMinSpeechSec: number;

  // ---- cross-meeting profile-matching gates (speaker-matcher.ts callers) ----
  /** Turn floor before a span is ever embedded at all (`SPEAKER_MIN_SEGMENT_SEC`). */
  minSegmentSec: number;
  /** Profile NAME bar `acceptMatch`/`acceptProfileMatch` require (`SPEAKER_MATCH_THRESHOLD`). */
  matchThreshold: number;
  /** Minimum best-vs-second-best margin `acceptMatch` requires before trusting a match (`SPEAKER_MATCH_MARGIN`). */
  matchMargin: number;
  /** Post-meeting AUTO-enrol bar (`auto-post` vectors only) — stricter than `matchThreshold`, which only gates NAMING (`SPEAKER_AUTO_ENROL_THRESHOLD`). */
  autoEnrolThreshold: number;
  /** Live one-shot enrolment: minimum accumulated speech before a live centroid is trusted enough to enrol (`LIVE_ENROL_MIN_SPEECH_SEC`). */
  liveEnrolMinSpeechSec: number;
  /** Live one-shot enrolment: minimum held-embedding coherence (`SPEAKER_LIVE_ENROL_COHERENCE`). */
  liveEnrolCoherence: number;
}

/**
 * Today's-behaviour default, built from the process-wide `env` (or an
 * explicit `AppEnv`, e.g. a test's own mutated copy, or a calibration run's
 * candidate numbers assembled as a plain object matching `AppEnv`'s shape).
 * The ONLY place a `SpeakerThresholds` consumer's constructor default reads
 * `env` at all — every other gate site reads the injected object instead.
 */
export function configFromEnv(source: AppEnv = env): SpeakerThresholds {
  return {
    sessionMatchThreshold: source.speakerSessionMatchThreshold,
    sessionUpdateThreshold: source.speakerSessionUpdateThreshold,
    updateMinSegmentSec: source.speakerUpdateMinSegmentSec,
    sessionScoreMode: source.speakerSessionScoreMode,
    sessionCentroidMode: source.speakerSessionCentroidMode,
    sessionMergeThreshold: source.speakerSessionMergeThreshold,
    sessionMergeStreak: source.speakerSessionMergeStreak,
    sessionMergeMinSpeechSec: source.speakerSessionMergeMinSpeechSec,
    liveMinSpeechSec: source.liveMinSpeechSec,
    minSegmentSec: source.speakerMinSegmentSec,
    matchThreshold: source.speakerMatchThreshold,
    matchMargin: source.speakerMatchMargin,
    autoEnrolThreshold: source.speakerAutoEnrolThreshold,
    liveEnrolMinSpeechSec: source.liveEnrolMinSpeechSec,
    liveEnrolCoherence: source.speakerLiveEnrolCoherence,
  };
}
