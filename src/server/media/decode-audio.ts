/**
 * Decodes the concatenated `audio.webm` to 16k mono pcm_s16le wav via
 * `@ffmpeg-installer/ffmpeg` (no system ffmpeg on hodao). Needed for EVERY
 * job (P4 embedding reads from the same wav) and is `elevenlabs-batch`'s
 * required input — for that provider decode runs BEFORE transcribe.
 */
import { spawn } from 'node:child_process';
import { open, stat } from 'node:fs/promises';

import ffmpeg from '@ffmpeg-installer/ffmpeg';

import { AppError } from '../../shared/app-error.js';

export interface DecodeResult {
  durationSec: number;
}

const DURATION_RE = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/;
const WAV_HEADER_BYTES = 44;
const SAMPLE_RATE = 16_000;
const BYTES_PER_SAMPLE = 2;
const BYTES_PER_SEC = SAMPLE_RATE * BYTES_PER_SAMPLE;

/** Spawn ffmpeg, keeping the child handle so an abort can `SIGKILL` it instead of merely rejecting the promise. */
export async function decodeToWav16k(inputPath: string, outputPath: string, signal: AbortSignal): Promise<DecodeResult> {
  if (signal.aborted) throw new AppError('Job đã huỷ trước khi decode audio.');

  const durationSec = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(ffmpeg.path, [
      '-hide_banner',
      '-y',
      '-i', inputPath,
      '-vn',
      '-ac', '1',
      '-ar', String(SAMPLE_RATE),
      '-c:a', 'pcm_s16le',
      outputPath,
    ]);

    let stderr = '';
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      child.kill('SIGKILL');
    };
    signal.addEventListener('abort', onAbort, { once: true });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      signal.removeEventListener('abort', onAbort);
      reject(new AppError(`Không chạy được ffmpeg để decode audio: ${err.message}`));
    });
    child.on('close', (code) => {
      signal.removeEventListener('abort', onAbort);
      if (aborted) {
        reject(new AppError('Job đã huỷ trong lúc decode audio.'));
        return;
      }
      if (code !== 0) {
        reject(new AppError(`ffmpeg decode thất bại (mã ${code}).`));
        return;
      }
      const match = DURATION_RE.exec(stderr);
      if (!match) {
        resolve(null);
        return;
      }
      resolve(Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]));
    });
  });

  if (durationSec !== null) return { durationSec };

  // ffmpeg's stderr banner did not carry a `Duration:` line — fall back to
  // computing it from the canonical 44-byte-header pcm_s16le wav we just wrote.
  const { size } = await stat(outputPath);
  const pcmBytes = Math.max(0, size - WAV_HEADER_BYTES);
  return { durationSec: pcmBytes / BYTES_PER_SEC };
}

/** Raw PCM16 mono samples between `fromSec`/`toSec`, normalized to [-1, 1] — the embedding input (P4). */
export async function readWavPcm(path: string, fromSec: number, toSec: number): Promise<Float32Array> {
  const fh = await open(path, 'r');
  try {
    const startByte = WAV_HEADER_BYTES + Math.max(0, Math.floor(fromSec * SAMPLE_RATE)) * BYTES_PER_SAMPLE;
    const endByte = WAV_HEADER_BYTES + Math.max(0, Math.floor(toSec * SAMPLE_RATE)) * BYTES_PER_SAMPLE;
    const length = Math.max(0, endByte - startByte);
    if (length === 0) return new Float32Array(0);
    const buffer = Buffer.alloc(length);
    await fh.read(buffer, 0, length, startByte);
    const samples = new Float32Array(Math.floor(length / BYTES_PER_SAMPLE));
    for (let i = 0; i < samples.length; i++) {
      samples[i] = buffer.readInt16LE(i * BYTES_PER_SAMPLE) / 32768;
    }
    return samples;
  } finally {
    await fh.close();
  }
}
