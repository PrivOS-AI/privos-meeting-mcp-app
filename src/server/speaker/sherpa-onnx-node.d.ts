/**
 * Minimal ambient declaration for `sherpa-onnx-node`. The package ships no
 * `.d.ts` and no `types` field in its `package.json` (verified against the
 * installed 1.13.8 tree), so without this file `tsc -p tsconfig.server.json`
 * fails under `strict`/`noImplicitAny` the moment anything imports it — with
 * OR without the optional platform binary (`sherpa-onnx-linux-x64`, etc.)
 * actually present in `node_modules`. Declaring the module ambiently keeps
 * both `tsc` projects green whether or not the native addon resolves at
 * runtime; `embedding-extractor.ts` is the only file that imports this
 * module (dynamically) and is solely responsible for surfacing a clear error
 * when the addon or the model file is missing.
 *
 * Shape covers exactly the surface this app uses — `SpeakerEmbeddingExtractor`
 * + its stream — verified against `node_modules/sherpa-onnx-node/speaker-identification.js`
 * and `streaming-asr.js` (the JS wrapper around the native addon).
 */
declare module 'sherpa-onnx-node' {
  export interface SpeakerEmbeddingExtractorConfig {
    model: string;
    numThreads?: number;
    debug?: boolean | number;
    provider?: string;
  }

  export interface Waveform {
    samples: Float32Array;
    sampleRate: number;
  }

  export class OnlineStream {
    acceptWaveform(obj: Waveform): void;
    inputFinished(): void;
  }

  export class SpeakerEmbeddingExtractor {
    constructor(config: SpeakerEmbeddingExtractorConfig);
    readonly dim: number;
    createStream(): OnlineStream;
    isReady(stream: OnlineStream): boolean;
    compute(stream: OnlineStream, enableExternalBuffer?: boolean): Float32Array;
  }

  // ---- Offline ASR, VAD, diarization (src/server/asr), verified against
  // non-streaming-asr.js, vad.js, non-streaming-speaker-diarization.js, types.js.

  export interface OfflineRecognizerConfig {
    featConfig?: { sampleRate?: number; featureDim?: number };
    modelConfig: {
      transducer?: { encoder: string; decoder: string; joiner: string };
      tokens: string;
      numThreads?: number;
      provider?: string;
      debug?: boolean | number;
    };
    decodingMethod?: string;
  }

  export interface OfflineRecognizerResult {
    text: string;
    tokens: string[];
    /** Seconds from the start of the stream, one per token. */
    timestamps: number[];
    ys_log_probs?: number[];
    lang?: string;
  }

  export class OfflineStream {
    acceptWaveform(obj: Waveform): void;
  }

  export class OfflineRecognizer {
    constructor(config: OfflineRecognizerConfig);
    static createAsync(config: OfflineRecognizerConfig): Promise<OfflineRecognizer>;
    createStream(): OfflineStream;
    decode(stream: OfflineStream): void;
    decodeAsync(stream: OfflineStream): Promise<void>;
    getResult(stream: OfflineStream): OfflineRecognizerResult;
  }

  export interface VadConfig {
    sileroVad: {
      model: string;
      threshold?: number;
      minSilenceDuration?: number;
      minSpeechDuration?: number;
      windowSize?: number;
      maxSpeechDuration?: number;
    };
    sampleRate?: number;
    numThreads?: number;
    debug?: boolean | number;
  }

  export interface SpeechSegmentResult {
    /** Sample index of the segment's first sample, counted since the VAD was created or reset. */
    start: number;
    samples: Float32Array;
  }

  export class Vad {
    constructor(config: VadConfig, bufferSizeInSeconds: number);
    acceptWaveform(samples: Float32Array): void;
    isEmpty(): boolean;
    isDetected(): boolean;
    front(enableExternalBuffer?: boolean): SpeechSegmentResult;
    pop(): void;
    clear(): void;
    reset(): void;
    flush(): void;
  }

  export interface OfflineSpeakerDiarizationConfig {
    segmentation: { pyannote: { model: string }; numThreads?: number; debug?: boolean | number };
    embedding: SpeakerEmbeddingExtractorConfig;
    clustering?: { numClusters?: number; threshold?: number };
    minDurationOn?: number;
    minDurationOff?: number;
  }

  export interface SpeakerDiarizationSegment {
    start: number;
    end: number;
    speaker: number;
  }

  export class OfflineSpeakerDiarization {
    constructor(config: OfflineSpeakerDiarizationConfig);
    readonly sampleRate: number;
    process(samples: Float32Array): SpeakerDiarizationSegment[];
  }

  export function readWave(filename: string): Waveform;

  const _default: {
    SpeakerEmbeddingExtractor: typeof SpeakerEmbeddingExtractor;
    OfflineRecognizer: typeof OfflineRecognizer;
    Vad: typeof Vad;
    OfflineSpeakerDiarization: typeof OfflineSpeakerDiarization;
    readWave: typeof readWave;
  };
  export default _default;
}
