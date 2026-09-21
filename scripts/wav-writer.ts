/** Minimal canonical 44-byte-header PCM16 mono WAV writer — the exact format `decode-audio.ts#readWavPcm` and `calibrate-speaker-threshold.ts` expect back. Split out of `extract-calibration-slices.ts` as the one pure encode/decode counterpart to that module's `readWavPcm`. */
const BYTES_PER_SAMPLE = 2;

export function encodeWav(pcm: Float32Array, sampleRate: number): Buffer {
  const dataBytes = pcm.length * BYTES_PER_SAMPLE;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16); // fmt chunk size
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * BYTES_PER_SAMPLE, 28); // byte rate
  buffer.writeUInt16LE(BYTES_PER_SAMPLE, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < pcm.length; i++) {
    const sample = Math.max(-1, Math.min(1, pcm[i]));
    buffer.writeInt16LE(Math.round(sample * 32767), 44 + i * BYTES_PER_SAMPLE);
  }
  return buffer;
}
