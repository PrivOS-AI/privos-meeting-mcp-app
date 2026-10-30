/**
 * Records a meeting from the Room's shared browser (PrivOS Remote Browser)
 * instead of the recorder's microphone: the browser joins a Google Meet call,
 * and this server reads what it plays from Remote Browser's `GET /audio-tap`
 * (raw 16 kHz mono PCM16, operator secret `REMOTE_BROWSER_AUDIO_TAP_KEY`).
 * PrivOS has no app-to-app call yet, so the two servers of one operator talk
 * directly; the room is the one the meeting owner's verified actor acts in.
 *
 * The audio takes the same two paths the microphone's does:
 *  - every ~0.5 s into the meeting's `LiveAsrSession` (live captions, live
 *    speakers), on a meeting clock kept in step with the wall clock — a gap in
 *    the stream (nothing playing, a reconnect) becomes silence, so bookmarks and
 *    caption times stay right;
 *  - into one ffmpeg webm/opus encoder whose output is uploaded as the usual
 *    `audio.part-NNNN-<id8>.webm` parts (~60 s each, keep_both) — one
 *    continuous stream cut by bytes, which `concat-parts.ts` puts back together,
 *    so `meeting_process` runs unchanged.
 *
 * A dropped stream (browser closed, controller restarted) is retried every few
 * seconds until `stop()`; the parts written so far are kept. In memory, one
 * replica, like the live session it feeds.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import ffmpeg from '@ffmpeg-installer/ffmpeg';
import type { RoomBoundHubClient } from '@privos_ai/app-server';

import { AppError } from '../../shared/app-error.js';
import { partFileName } from '../../shared/meeting-slug.js';
import { liveSessionFor, type LiveAsrSession } from '../asr/live-asr-session.js';
import { env } from '../env.js';
import { uploadBotFile } from '../files/hub-file-upload.js';
import type { AppDbBotClient } from '../hub/app-db-bot-client.js';
import { createLocalSpeakerAttributor } from '../live-speakers/local-attribution.js';

const SAMPLE_RATE = 16_000;
const BYTES_PER_SECOND = SAMPLE_RATE * 2;
/** Audio handed to the recognizer per push: the session reacts at chunk ends, and 0.25 s brought the first draft ~0.3 s sooner than 0.5 s (scripts/eval-caption-latency.ts). */
const PUSH_BYTES = BYTES_PER_SECOND / 4;
/** Seconds of audio per uploaded part. */
const PART_SEC = 60;
/** The stream may lag the wall clock by this much before the gap is filled with silence. */
const GAP_FILL_SEC = 1.5;
const RECONNECT_MS = 4_000;

export type BrowserAudioState = 'connecting' | 'listening' | 'waiting' | 'stopped';
/** Why the browser cannot be heard right now: no browser running in the Room, a runtime without audio, too many listeners, or Remote Browser unreachable. */
export type BrowserAudioProblem = 'no_browser' | 'no_audio' | 'busy' | 'unavailable' | 'unauthorized';

export interface BrowserAudioStatus {
  state: BrowserAudioState;
  problem?: BrowserAudioProblem;
  /** Seconds of meeting audio taken in so far (including filled gaps). */
  heardSec: number;
  partsUploaded: number;
}

export interface BrowserAudioContext {
  db: AppDbBotClient;
  hub: RoomBoundHubClient;
  roomId: string;
  folderId: string;
  meetingId: string;
  /** The wall clock the meeting clock is kept in step with; tests pass their own. */
  now?: () => number;
}

/** Resolves after `ms`, or as soon as `signal` aborts. */
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
  });
}

/** Remote Browser's audio route is configured for this deployment. */
export function browserAudioConfigured(): boolean {
  return Boolean(env.remoteBrowserAudioUrl && env.remoteBrowserAudioTapKey);
}

function problemFor(status: number, code: unknown): BrowserAudioProblem {
  if (code === 'no_browser' || code === 'no_audio' || code === 'busy') return code;
  if (status === 401) return 'unauthorized';
  return 'unavailable';
}

export class BrowserAudioListener {
  private state: BrowserAudioState = 'connecting';
  private problem: BrowserAudioProblem | undefined;
  private readonly abort = new AbortController();
  private readonly now: () => number;
  private readonly startedAt: number;
  /** Bytes of meeting audio fed so far: the meeting clock. */
  private fedBytes = 0;
  private pushSeq = 0;
  private pending: Buffer = Buffer.alloc(0);
  private encoder: ChildProcessWithoutNullStreams | null = null;
  private encoded: Buffer[] = [];
  private encodedBytes = 0;
  private bytesAtLastPart = 0;
  private partSeq = 0;
  private uploads: Promise<void> = Promise.resolve();
  private session: LiveAsrSession | null;
  private loop: Promise<void>;

  constructor(private readonly ctx: BrowserAudioContext) {
    this.now = ctx.now ?? Date.now;
    this.startedAt = this.now();
    this.session = liveSessionFor(ctx.meetingId, env.liveMaxConcurrentRecordings);
    if (!this.session) {
      throw new AppError(`The app is already captioning the maximum of ${env.liveMaxConcurrentRecordings} meetings.`, 'CAPACITY_REACHED');
    }
    this.session.attributeSpeaker ??= createLocalSpeakerAttributor(ctx);
    this.startEncoder();
    this.loop = this.run();
  }

  status(): BrowserAudioStatus {
    return {
      state: this.state,
      ...(this.problem ? { problem: this.problem } : {}),
      heardSec: Math.round((this.fedBytes / BYTES_PER_SECOND) * 10) / 10,
      partsUploaded: this.partSeq,
    };
  }

  captionsSince(cursor: number) {
    return { ...this.session!.captionsSince(cursor), degraded: this.session!.degraded };
  }

  /** Stops listening, feeds what is left, and uploads the last part. Resolves when every part is saved. */
  async stop(): Promise<void> {
    if (this.state === 'stopped') return this.uploads;
    this.state = 'stopped';
    this.abort.abort();
    await this.loop.catch(() => undefined);
    await this.flushPending();
    await this.finishEncoder();
    await this.uploads;
  }

  private async run(): Promise<void> {
    while (!this.abort.signal.aborted) {
      try {
        await this.listenOnce();
      } catch (error) {
        if (this.abort.signal.aborted) return;
        if (!this.problem) this.problem = 'unavailable';
        console.warn('[browser-audio] stream ended, retrying:', this.ctx.meetingId, error instanceof Error ? error.message : error);
      }
      if (this.abort.signal.aborted) return;
      this.state = 'waiting';
      await wait(RECONNECT_MS, this.abort.signal);
    }
  }

  private async listenOnce(): Promise<void> {
    const url = `${env.remoteBrowserAudioUrl!.replace(/\/+$/, '')}/audio-tap?roomId=${encodeURIComponent(this.ctx.roomId)}`;
    const response = await fetch(url, { headers: { Authorization: `Bearer ${env.remoteBrowserAudioTapKey}` }, signal: this.abort.signal });
    if (!response.ok || !response.body) {
      const body = (await response.json().catch(() => null)) as { code?: unknown } | null;
      this.problem = problemFor(response.status, body?.code);
      this.state = 'waiting';
      return;
    }
    this.problem = undefined;
    this.state = 'listening';
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      if (this.abort.signal.aborted) return;
      await this.take(Buffer.from(chunk));
    }
    if (!this.abort.signal.aborted) this.problem = 'no_browser';
  }

  /** New PCM from the browser: fill any gap with silence first, then feed in pushes of ~0.5 s. */
  private async take(chunk: Buffer): Promise<void> {
    const behindSec = (this.now() - this.startedAt) / 1000 - (this.fedBytes + this.pending.length + chunk.length) / BYTES_PER_SECOND;
    if (behindSec > GAP_FILL_SEC) {
      const silence = Math.floor((behindSec - 0.25) * SAMPLE_RATE) * 2;
      await this.feed(Buffer.alloc(silence));
    }
    await this.feed(chunk);
  }

  private async feed(bytes: Buffer): Promise<void> {
    this.pending = this.pending.length ? Buffer.concat([this.pending, bytes]) : bytes;
    while (this.pending.length >= PUSH_BYTES) {
      const push = this.pending.subarray(0, PUSH_BYTES);
      this.pending = this.pending.subarray(PUSH_BYTES);
      await this.pushToRecognizer(push);
    }
  }

  private async flushPending(): Promise<void> {
    const whole = this.pending.length - (this.pending.length % 2);
    if (whole > 0) await this.pushToRecognizer(this.pending.subarray(0, whole));
    this.pending = Buffer.alloc(0);
  }

  private async pushToRecognizer(pcm: Buffer): Promise<void> {
    const atSec = this.fedBytes / BYTES_PER_SECOND;
    this.fedBytes += pcm.length;
    this.encoder?.stdin.write(pcm);
    const samples = new Float32Array(pcm.length / 2);
    for (let i = 0; i < samples.length; i++) samples[i] = pcm.readInt16LE(i * 2) / 32768;
    try {
      await this.session!.push(this.pushSeq++, atSec, samples);
    } catch (error) {
      console.warn('[browser-audio] live recognition push failed:', this.ctx.meetingId, error instanceof Error ? error.message : error);
    }
    if (this.fedBytes - this.bytesAtLastPart >= PART_SEC * BYTES_PER_SECOND) {
      this.bytesAtLastPart = this.fedBytes;
      this.cutPart();
    }
  }

  private startEncoder(): void {
    const child = spawn(ffmpeg.path, ['-hide_banner', '-loglevel', 'error', '-f', 's16le', '-ar', String(SAMPLE_RATE), '-ac', '1', '-i', 'pipe:0', '-c:a', 'libopus', '-b:a', '32k', '-f', 'webm', 'pipe:1'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (data: Buffer) => {
      this.encoded.push(data);
      this.encodedBytes += data.length;
    });
    child.stderr.on('data', (data: Buffer) => console.warn('[browser-audio] encoder:', data.toString().trim().slice(0, 300)));
    child.stdin.on('error', () => undefined);
    this.encoder = child;
  }

  private async finishEncoder(): Promise<void> {
    const child = this.encoder;
    if (!child) return;
    this.encoder = null;
    const exited = new Promise<void>((resolve) => child.once('close', () => resolve()));
    child.stdin.end();
    await exited;
    this.cutPart();
  }

  /** Uploads what the encoder produced since the last part as the next part (in order, one at a time). */
  private cutPart(): void {
    if (this.encodedBytes === 0) return;
    const data = Buffer.concat(this.encoded);
    this.encoded = [];
    this.encodedBytes = 0;
    const seq = this.partSeq++;
    const { hub, roomId, folderId, meetingId } = this.ctx;
    this.uploads = this.uploads.then(async () => {
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await uploadBotFile({ hub, roomId, folderId, fileName: partFileName(seq, meetingId), mimeType: 'audio/webm', data, duplicateAction: 'keep_both' });
          // The same heartbeat the iframe's recorder writes: the startup sweep marks a `recording`
          // meeting without a recent part `interrupted`.
          await this.ctx.db.update('meetings', 'room', meetingId, { partCount: seq + 1, lastPartAt: new Date().toISOString() }).catch(() => undefined);
          return;
        } catch (error) {
          console.warn(`[browser-audio] uploading part ${seq} failed (attempt ${attempt}):`, meetingId, error instanceof Error ? error.message : error);
          if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 2_000 * attempt));
        }
      }
    });
  }
}

const listeners = new Map<string, BrowserAudioListener>();

/** Starts (or returns the running) listener for this meeting. */
export function startBrowserAudio(ctx: BrowserAudioContext): BrowserAudioListener {
  if (!browserAudioConfigured()) throw new AppError('Listening through the Room browser is not set up on this deployment.', 'PROVIDER_NOT_CONFIGURED');
  const existing = listeners.get(ctx.meetingId);
  if (existing) return existing;
  const listener = new BrowserAudioListener(ctx);
  listeners.set(ctx.meetingId, listener);
  return listener;
}

export function browserAudioFor(meetingId: string): BrowserAudioListener | undefined {
  return listeners.get(meetingId);
}

/** Stops the meeting's listener, if any, once its last part is saved. Safe to call twice. */
export async function stopBrowserAudio(meetingId: string): Promise<BrowserAudioStatus | undefined> {
  const listener = listeners.get(meetingId);
  if (!listener) return undefined;
  try {
    await listener.stop();
    return listener.status();
  } finally {
    listeners.delete(meetingId);
  }
}
