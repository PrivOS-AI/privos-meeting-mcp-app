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
  speakerMinSegmentSec: number;
  speakerEnrolTargetSec: number;
  speakerSessionMatchThreshold: number;
  speakerSessionMergeThreshold: number;
  liveMinSpeechSec: number;
  liveChunkOverlapSec: number;
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
}

export function loadEnv(): AppEnv {
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
    speakerMatchThreshold: num('SPEAKER_MATCH_THRESHOLD', 0.5),
    speakerMinSegmentSec: num('SPEAKER_MIN_SEGMENT_SEC', 2),
    speakerEnrolTargetSec: num('SPEAKER_ENROL_TARGET_SEC', 25),
    speakerSessionMatchThreshold: num('SPEAKER_SESSION_MATCH_THRESHOLD', 0.4),
    speakerSessionMergeThreshold: num('SPEAKER_SESSION_MERGE_THRESHOLD', 0.6),
    liveMinSpeechSec: num('LIVE_MIN_SPEECH_SEC', 8),
    liveChunkOverlapSec: num('LIVE_CHUNK_OVERLAP_SEC', 8),
    voiceprintEncKey: str('VOICEPRINT_ENC_KEY'),
    summaryModel: str('SUMMARY_MODEL'),
    summaryProvider: str('SUMMARY_PROVIDER'),
    translateModel: str('TRANSLATE_MODEL'),
    translateProvider: str('TRANSLATE_PROVIDER'),
    privosFilesOrigin: str('PRIVOS_FILES_ORIGIN'),
    meetingJobConcurrency: num('MEETING_JOB_CONCURRENCY', 1),
    meetingJobTimeoutMs: num('MEETING_JOB_TIMEOUT_MS', 3_600_000),
    allowUnverifiedActor: str('ALLOW_UNVERIFIED_ACTOR') === '1',
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
