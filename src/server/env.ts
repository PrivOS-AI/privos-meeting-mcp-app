/**
 * Typed, validated configuration. Read env ONCE here and export a typed object
 * so the rest of the server never reaches into `process.env` directly.
 *
 * `SONIOX_API_KEY` and `ELEVENLABS_API_KEY` are both optional, but the SELECTED
 * provider must have its key. That is only fatal in production
 * (`assertProviderKeysAtBoot`), so dev, tests and preflight boot without any
 * vendor key configured.
 */
import { resolveRuntimeMode } from '@privos_ai/app-server';

type SttVendor = 'soniox' | 'elevenlabs';

function str(key: string): string | undefined {
  const v = process.env[key];
  return v && v.trim() ? v.trim() : undefined;
}

function num(key: string, fallback: number): number {
  const v = str(key);
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function vendor(key: string, fallback: SttVendor): SttVendor {
  const v = str(key)?.toLowerCase();
  return v === 'soniox' || v === 'elevenlabs' ? v : fallback;
}

export type SessionScoreMode = 'max' | 'centroid';
export type SessionCentroidMode = 'fifo' | 'anchors';

function sessionScoreMode(key: string, fallback: SessionScoreMode): SessionScoreMode {
  const v = str(key)?.toLowerCase();
  return v === 'max' || v === 'centroid' ? v : fallback;
}

function sessionCentroidMode(key: string, fallback: SessionCentroidMode): SessionCentroidMode {
  const v = str(key)?.toLowerCase();
  return v === 'fifo' || v === 'anchors' ? v : fallback;
}

export interface AppEnv {
  port: number;
  realtimeProvider: SttVendor;
  asyncProvider: SttVendor;
  sonioxApiKey?: string;
  elevenLabsApiKey?: string;
  sonioxRtModel: string;
  sonioxAsyncModel: string;
  elevenLabsRealtimeModel: string;
  elevenLabsBatchModel: string;
  elevenLabsDiarizationThreshold: number;
  sonioxTempKeyTtlSec: number;
  liveMaxConcurrentRecordings: number;
  liveUploadRetryWindowMin: number;
  speakerModelPath: string;
  speakerMatchThreshold: number;
  /** Minimum gap `matchSpeaker`'s best score must keep over the runner-up profile before a match is trusted (`SPEAKER_MATCH_MARGIN`) — neutral default 0 reproduces "accept on threshold alone". */
  speakerMatchMargin: number;
  /** Post-meeting AUTO-enrol bar (`auto-post` vectors only) — stricter than `speakerMatchThreshold` (which only gates NAMING). Neutral default = `speakerMatchThreshold`. */
  speakerAutoEnrolThreshold: number;
  speakerMinSegmentSec: number;
  speakerEnrolTargetSec: number;
  speakerSessionMatchThreshold: number;
  /** UPDATE bar — whether a folded embedding may change its session speaker's centroid at all; neutral default = ASSIGN (`speakerSessionMatchThreshold`), raised after phase-4 calibration. Never gates attribution — a turn scoring between UPDATE and ASSIGN still shows in the UI and counts as speech. */
  speakerSessionUpdateThreshold: number;
  /** Minimum turn duration (seconds) allowed to update a centroid; neutral default = `speakerMinSegmentSec` (turns below that never even reach `observe`, so this is a no-op bar today). Shorter turns are attribution-only. The very first embedding of a brand-new session speaker is exempt (nothing to seed with yet). */
  speakerUpdateMinSegmentSec: number;
  /** `max` (today): score = max cosine over this speaker's currently held embeddings, reproducing `matchSpeaker`'s per-vector comparison without borrowing that module. `centroid`: score = cosine to the speaker's current centroid (systematically lower at the same threshold) — flipped only after phase-4 calibration. */
  speakerSessionScoreMode: SessionScoreMode;
  /** `fifo` (today): centroid = plain mean of the last 10 held embeddings, oldest evicted. `anchors`: up to 5 pinned first-quality embeddings (never evicted) + a rolling window of 10 recent, duration-weighted mean — flipped only after phase-4 calibration. */
  speakerSessionCentroidMode: SessionCentroidMode;
  speakerSessionMergeThreshold: number;
  /** Consecutive `observe()`-triggered checks a pair must clear `speakerSessionMergeThreshold` on (with a changed centroid each time) before it actually merges. 1 = today's single-shot behaviour; raise after phase-4 calibration. */
  speakerSessionMergeStreak: number;
  /** Both sides' accumulated speech (seconds) required before a merge is even considered; 0 disables the gate (today's behaviour). Once >0, both sides also need >=3 held embeddings. */
  speakerSessionMergeMinSpeechSec: number;
  liveMinSpeechSec: number;
  liveChunkOverlapSec: number;
  /** One-shot live enrolment bar (speaker_resolve time): minimum accumulated speech before a live centroid is trusted enough to enrol as `user-live`. */
  liveEnrolMinSpeechSec: number;
  /** Own coherence bar for the live one-shot enrol decision — a min-pairwise-cosine over ~2-5s noisy shared-mic turns is a different distribution than the post-meeting picked-range coherence, so it must not share `speakerMatchThreshold`. */
  speakerLiveEnrolCoherence: number;
  voiceprintEncKey?: string;
  summaryModel?: string;
  /** Hub AI provider id paired with `summaryModel` (Hub default when unset). */
  summaryProvider?: string;
  /** Translation can run on a cheaper/faster model than the summary; falls back to the summary pair. */
  translateModel?: string;
  translateProvider?: string;
  privosFilesOrigin?: string;
  meetingJobConcurrency: number;
  meetingJobTimeoutMs: number;
  allowUnverifiedActor: boolean;
  /**
   * Calibration-only, ENV-ONLY (never `app_settings` — this is an operator
   * toggle, not a per-room setting): while `true`, `meeting-job.ts` skips
   * deleting a meeting's uploaded recording parts after concat, so
   * `scripts/replay-meeting-speakers.ts` can decode them part-by-part with
   * the same 8s overlap ring the live chunk worker used, instead of only the
   * single concatenated file. Default `false` reproduces today's behaviour
   * (parts deleted right after concat). The operator flips this on, records
   * a calibration meeting, then flips it back off.
   */
  keepPartsForCalibration: boolean;
}

export function loadEnv(): AppEnv {
  // Computed up front (not inline in the object literal below) so the two new
  // gates' "neutral default = today's other setting" fallback picks up an
  // explicit override of THAT setting too, not just its own hardcoded default.
  const speakerMinSegmentSec = num('SPEAKER_MIN_SEGMENT_SEC', 2);
  const speakerSessionMatchThreshold = num('SPEAKER_SESSION_MATCH_THRESHOLD', 0.4);
  const speakerMatchThreshold = num('SPEAKER_MATCH_THRESHOLD', 0.5);
  return {
    port: num('PORT', 3012),
    realtimeProvider: vendor('STT_REALTIME_PROVIDER', 'soniox'),
    asyncProvider: vendor('STT_ASYNC_PROVIDER', 'soniox'),
    sonioxApiKey: str('SONIOX_API_KEY'),
    elevenLabsApiKey: str('ELEVENLABS_API_KEY'),
    sonioxRtModel: str('SONIOX_RT_MODEL') ?? 'stt-rt-v5',
    sonioxAsyncModel: str('SONIOX_ASYNC_MODEL') ?? 'stt-async-v5',
    elevenLabsRealtimeModel: str('ELEVENLABS_REALTIME_MODEL') ?? 'scribe_v2_realtime',
    elevenLabsBatchModel: str('ELEVENLABS_BATCH_MODEL') ?? 'scribe_v2',
    elevenLabsDiarizationThreshold: num('ELEVENLABS_DIARIZATION_THRESHOLD', 0.22),
    sonioxTempKeyTtlSec: num('SONIOX_TEMP_KEY_TTL_SEC', 900),
    liveMaxConcurrentRecordings: num('LIVE_MAX_CONCURRENT_RECORDINGS', 8),
    liveUploadRetryWindowMin: num('LIVE_UPLOAD_RETRY_WINDOW_MIN', 15),
    speakerModelPath: str('SPEAKER_MODEL_PATH') ?? 'models/3dspeaker_speaker-embedding_advanced.onnx',
    speakerMatchThreshold,
    speakerMatchMargin: num('SPEAKER_MATCH_MARGIN', 0),
    speakerAutoEnrolThreshold: num('SPEAKER_AUTO_ENROL_THRESHOLD', speakerMatchThreshold),
    speakerMinSegmentSec,
    speakerEnrolTargetSec: num('SPEAKER_ENROL_TARGET_SEC', 25),
    speakerSessionMatchThreshold,
    speakerSessionUpdateThreshold: num('SPEAKER_SESSION_UPDATE_THRESHOLD', speakerSessionMatchThreshold),
    speakerUpdateMinSegmentSec: num('SPEAKER_UPDATE_MIN_SEGMENT_SEC', speakerMinSegmentSec),
    speakerSessionScoreMode: sessionScoreMode('SPEAKER_SESSION_SCORE_MODE', 'max'),
    speakerSessionCentroidMode: sessionCentroidMode('SPEAKER_SESSION_CENTROID_MODE', 'fifo'),
    speakerSessionMergeThreshold: num('SPEAKER_SESSION_MERGE_THRESHOLD', 0.6),
    speakerSessionMergeStreak: num('SPEAKER_SESSION_MERGE_STREAK', 1),
    speakerSessionMergeMinSpeechSec: num('SPEAKER_SESSION_MERGE_MIN_SPEECH_SEC', 0),
    liveMinSpeechSec: num('LIVE_MIN_SPEECH_SEC', 8),
    liveChunkOverlapSec: num('LIVE_CHUNK_OVERLAP_SEC', 8),
    liveEnrolMinSpeechSec: num('LIVE_ENROL_MIN_SPEECH_SEC', 20),
    speakerLiveEnrolCoherence: num('SPEAKER_LIVE_ENROL_COHERENCE', 0.5),
    voiceprintEncKey: str('VOICEPRINT_ENC_KEY'),
    summaryModel: str('SUMMARY_MODEL'),
    summaryProvider: str('SUMMARY_PROVIDER'),
    translateModel: str('TRANSLATE_MODEL'),
    translateProvider: str('TRANSLATE_PROVIDER'),
    privosFilesOrigin: str('PRIVOS_FILES_ORIGIN'),
    meetingJobConcurrency: num('MEETING_JOB_CONCURRENCY', 1),
    meetingJobTimeoutMs: num('MEETING_JOB_TIMEOUT_MS', 3_600_000),
    allowUnverifiedActor: str('ALLOW_UNVERIFIED_ACTOR') === '1',
    keepPartsForCalibration: str('MEETING_KEEP_PARTS_FOR_CALIBRATION') === '1',
  };
}

/** The process-wide config, read once. */
export const env: AppEnv = loadEnv();

/**
 * True only under the SDK's resolved `development` runtime mode — NOT
 * `NODE_ENV`. The real posture comes from workload-socket / identity-file
 * presence (managed `start` never sets NODE_ENV), so keying dev-only escape
 * hatches and fatal boot checks on this is the only way managed production is
 * provably fail-closed. An unresolvable mode is treated as non-development
 * (fail closed).
 */
export function isDevelopmentRuntime(): boolean {
  try {
    return resolveRuntimeMode().mode === 'development';
  } catch {
    return false;
  }
}

function keyForProvider(config: AppEnv, provider: SttVendor): string | undefined {
  return provider === 'soniox' ? config.sonioxApiKey : config.elevenLabsApiKey;
}

/**
 * Fail-fast at boot IN PRODUCTION when the selected realtime/async provider has
 * no key, or when the voiceprint key is missing. The message names the setting
 * that points at the provider so the operator knows which key to add. Returns a
 * list of warnings (non-fatal in dev) rather than throwing there.
 */
export function assertProviderKeysAtBoot(config: AppEnv = env): string[] {
  const problems: string[] = [];
  if (!keyForProvider(config, config.realtimeProvider)) {
    problems.push(
      `STT_REALTIME_PROVIDER=${config.realtimeProvider} but missing ${config.realtimeProvider === 'soniox' ? 'SONIOX_API_KEY' : 'ELEVENLABS_API_KEY'}.`,
    );
  }
  if (!keyForProvider(config, config.asyncProvider)) {
    problems.push(
      `STT_ASYNC_PROVIDER=${config.asyncProvider} but missing ${config.asyncProvider === 'soniox' ? 'SONIOX_API_KEY' : 'ELEVENLABS_API_KEY'}.`,
    );
  }
  if (problems.length && !isDevelopmentRuntime()) {
    throw new Error(`Invalid configuration at boot:\n- ${problems.join('\n- ')}`);
  }
  return problems;
}
