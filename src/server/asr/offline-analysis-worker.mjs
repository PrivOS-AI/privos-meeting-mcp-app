/**
 * Worker thread for the post-meeting pass: Silero VAD over the whole file and
 * speaker diarization (pyannote segmentation + speaker embedding). Both are
 * synchronous in sherpa-onnx and can run for minutes on a long meeting, so
 * they run here instead of blocking the server's event loop. Plain .mjs: a
 * worker does not get tsx's loader.
 *
 * In:  workerData = { wavPath, vadModel, segmentationModel, embeddingModel, diarize, clusterThreshold }
 * Out: { segments: [{ startSec, endSec }], turns: [{ startSec, endSec, speaker }] } or { error }
 * Only boundaries go back; the caller slices the samples itself.
 */
import { parentPort, workerData } from 'node:worker_threads';

import sherpa from 'sherpa-onnx-node';

const SAMPLE_RATE = 16000;
const WINDOW = 512;

function speechSegments(samples) {
  const vad = new sherpa.Vad(
    {
      sileroVad: { model: workerData.vadModel, threshold: 0.5, minSilenceDuration: 0.4, minSpeechDuration: 0.25, windowSize: WINDOW, maxSpeechDuration: 15 },
      sampleRate: SAMPLE_RATE,
      numThreads: 1,
      debug: 0,
    },
    60,
  );
  const segments = [];
  const drain = () => {
    while (!vad.isEmpty()) {
      const segment = vad.front(false);
      vad.pop();
      segments.push({ startSec: segment.start / SAMPLE_RATE, endSec: (segment.start + segment.samples.length) / SAMPLE_RATE });
    }
  };
  for (let i = 0; i + WINDOW <= samples.length; i += WINDOW) {
    vad.acceptWaveform(samples.subarray(i, i + WINDOW));
    drain();
  }
  vad.flush();
  drain();
  return segments;
}

function speakerTurns(samples) {
  const diarizer = new sherpa.OfflineSpeakerDiarization({
    segmentation: { pyannote: { model: workerData.segmentationModel }, numThreads: 1, debug: 0 },
    embedding: { model: workerData.embeddingModel, numThreads: 1, debug: 0 },
    clustering: { numClusters: -1, threshold: workerData.clusterThreshold },
    minDurationOn: 0.3,
    minDurationOff: 0.5,
  });
  return diarizer.process(samples).map((turn) => ({ startSec: turn.start, endSec: turn.end, speaker: turn.speaker }));
}

try {
  const wave = sherpa.readWave(workerData.wavPath);
  if (wave.sampleRate !== SAMPLE_RATE) throw new Error(`expected ${SAMPLE_RATE} Hz audio, got ${wave.sampleRate} Hz`);
  const segments = speechSegments(wave.samples);
  const turns = workerData.diarize ? speakerTurns(wave.samples) : [];
  parentPort.postMessage({ segments, turns });
} catch (error) {
  parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) });
}
