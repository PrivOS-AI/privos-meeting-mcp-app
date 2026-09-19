/**
 * Lazy, process-wide singleton around `sherpa-onnx-node`'s
 * `SpeakerEmbeddingExtractor` (D-02). Both the P3/P4 post-meeting job and
 * the P5 live chunk worker call `computeEmbedding` — the model loads AT MOST
 * ONCE per process no matter how many callers/how many times it's invoked.
 *
 * `sherpa-onnx-node` is isolated behind this one module via a DYNAMIC import:
 * the package ships no `.d.ts` (see `sherpa-onnx-node.d.ts` for why an
 * ambient declaration is still required even though the native addon itself
 * installed successfully for linux-x64 in this environment), and the model
 * file (`SPEAKER_MODEL_PATH`) is provisioned at deploy time, never committed
 * — so this module must degrade to a clear, catchable error both when the
 * package's native binary cannot load AND when the model file is absent,
 * without ever crashing the whole process at import time.
 *
 * Model choice: `SPEAKER_MODEL_PATH` defaults to the plan's documented
 * candidate (`models/3dspeaker_speaker-embedding_advanced.onnx`, see
 * `src/server/env.ts`) — open question #5 in plan.md (EER/model benchmark
 * across the 3 candidates via `scripts/calibrate-speaker-threshold.ts`) is
 * unresolved by design; this extractor is model-agnostic and reads `dim`
 * from the loaded model at runtime rather than hardcoding it, so swapping
 * `SPEAKER_MODEL_PATH` never requires a code change.
 */
import { existsSync } from 'node:fs';

import { AppError } from '../../shared/app-error.js';
import { env } from '../env.js';

/** `numThreads`/`provider` are the plan's documented defaults (`plan.md` § Backend — extractor) — not yet benchmarked, same open question as the model choice. */
const NUM_THREADS = 2;
const PROVIDER = 'cpu';

interface ExtractorHandle {
  readonly dim: number;
  createStream(): { acceptWaveform(obj: { samples: Float32Array; sampleRate: number }): void; inputFinished(): void };
  isReady(stream: ReturnType<ExtractorHandle['createStream']>): boolean;
  compute(stream: ReturnType<ExtractorHandle['createStream']>, enableExternalBuffer?: boolean): Float32Array;
}

let singleton: Promise<ExtractorHandle> | null = null;

async function loadExtractor(): Promise<ExtractorHandle> {
  if (!existsSync(env.speakerModelPath)) {
    throw new AppError(
      `Speaker recognition model not found at "${env.speakerModelPath}" (env var SPEAKER_MODEL_PATH). `
        + 'The ONNX model is fetched at deploy time (see docs/deployment-guide.md), it is not part of the source code.',
    );
  }

  let sherpaModule: { SpeakerEmbeddingExtractor: new (config: { model: string; numThreads: number; provider: string }) => ExtractorHandle };
  try {
    // Dynamic import keeps sherpa-onnx-node's native addon out of this
    // module's static import graph — a load failure (missing/incompatible
    // native binary for the host platform) surfaces here as an AppError
    // instead of crashing the whole process at startup.
    const imported = (await import('sherpa-onnx-node')) as unknown as {
      default: { SpeakerEmbeddingExtractor: new (config: { model: string; numThreads: number; provider: string }) => ExtractorHandle };
    };
    sherpaModule = imported.default;
  } catch (error) {
    throw new AppError(`Could not load sherpa-onnx-node: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    return new sherpaModule.SpeakerEmbeddingExtractor({ model: env.speakerModelPath, numThreads: NUM_THREADS, provider: PROVIDER });
  } catch (error) {
    throw new AppError(`Could not initialize the speaker recognition model: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Returns the shared extractor, loading it on first call. A load failure does NOT poison the singleton — the next call retries (e.g. the model file appears after a deploy fix). */
function getExtractor(): Promise<ExtractorHandle> {
  if (!singleton) {
    singleton = loadExtractor().catch((error: unknown) => {
      singleton = null;
      throw error;
    });
  }
  return singleton;
}

/**
 * Computes one speaker embedding from raw PCM16-normalized samples
 * (`Float32Array`, range [-1, 1]) at `sampleRate` (default 16k, matching
 * `decode-audio.ts`'s output). Never returns a vector shorter than the
 * model's own `dim` — callers never need to know the model's dimensionality
 * ahead of time (`getEmbeddingDim` reads it from the loaded model).
 */
export async function computeEmbedding(samples: Float32Array, sampleRate = 16000): Promise<Float32Array> {
  const extractor = await getExtractor();
  const stream = extractor.createStream();
  stream.acceptWaveform({ samples, sampleRate });
  stream.inputFinished();
  if (!extractor.isReady(stream)) {
    throw new AppError('Audio segment is too short to compute a speaker embedding.');
  }
  return extractor.compute(stream, true);
}

/** The active model's embedding dimensionality — read from the model at runtime, never hardcoded (models differ). */
export async function getEmbeddingDim(): Promise<number> {
  const extractor = await getExtractor();
  return extractor.dim;
}

/** Test-only: forces a fresh singleton on the next call (a test may swap `env.speakerModelPath` or mock the module). */
export function resetSpeakerEmbeddingExtractorForTests(): void {
  singleton = null;
}
