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

  const _default: {
    SpeakerEmbeddingExtractor: typeof SpeakerEmbeddingExtractor;
  };
  export default _default;
}
