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
 * A dropped stream (browser closed, controller restarted) is retried with a
 * backoff (2 s doubling to 60 s), logged on the first failure and then at most
 * once a minute; the parts written so far are kept. Nobody has to remember to
 * stop it: it stops by itself (`onAutoStop`, which ends the meeting) after the
 * longest allowed recording, after a stretch without sound, or after a stretch
 * without reaching the Room browser's audio at all (`BROWSER_RECORDING_*`), and
 * it stops quietly when its meeting is deleted or ended elsewhere. In memory,
 * one replica, like the live session it feeds: a restart ends every listener
 * and none is resumed on its own.
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
/** A push this loud (RMS of samples in -1..1, about -46 dBFS) is sound; below it, silence. */
const SOUND_RMS = 0.005;
/** A meeting row reported gone this many checks in a row is gone (one odd Hub answer is not enough). */
const GONE_CHECKS = 2;
/** How long an ended listener is remembered: a poll still learns why, and a late retry cannot restart it. */
const ENDED_KEEP_MS = 60 * 60_000;

export type BrowserAudioState = 'connecting' | 'listening' | 'waiting' | 'stopped';
/** Why the browser cannot be heard right now: no browser running in the Room, a runtime without audio, too many listeners, or Remote Browser unreachable. */
export type BrowserAudioProblem = 'no_browser' | 'no_audio' | 'busy' | 'unavailable' | 'unauthorized';
/** Why a listener stopped by itself: the longest allowed recording, a stretch without sound, or the Room browser's audio never reached. */
export type BrowserAudioEndReason = 'max_duration' | 'silence' | 'unreachable';

export interface BrowserAudioStatus {
  state: BrowserAudioState;
  problem?: BrowserAudioProblem;
  /** Seconds of meeting audio taken in so far (including filled gaps). */
  heardSec: number;
  partsUploaded: number;
  /** Set once the listener stopped by itself. */
  endReason?: BrowserAudioEndReason;
}

/** When a listener stops by itself, in ms. Defaults: `BROWSER_RECORDING_MAX_MIN`, `_SILENCE_STOP_MIN`, `_UNREACHABLE_STOP_MIN`. */
export interface BrowserAudioLimits {
  maxMs: number;
  silenceMs: number;
  unreachableMs: number;
}

/** Retry, check and log pacing, in ms; tests pass their own. */
export interface BrowserAudioTiming {
  reconnectMinMs: number;
  reconnectMaxMs: number;
  /** How often the limits are checked. */
  checkEveryMs: number;
  /** How often the meeting row is checked (deleted, or ended elsewhere). */
  rowCheckEveryMs: number;
  /** At most one "cannot reach" line per this long. */
  logEveryMs: number;
  wait: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface BrowserAudioContext {
  db: AppDbBotClient;
  hub: RoomBoundHubClient;
  roomId: string;
  folderId: string;
  meetingId: string;
  /** The wall clock the meeting clock and the limits are kept on; tests pass their own. */
  now?: () => number;
  /** When the meeting started recording (ms): the longest-recording limit counts from there, also for a listener resumed later. Default: now. */
  recordingStartedAt?: number;
  /** Runs once when the listener stopped by itself, after its last part is saved: end the meeting there. */
  onAutoStop?: (reason: BrowserAudioEndReason, status: BrowserAudioStatus) => Promise<void> | void;
  limits?: Partial<BrowserAudioLimits>;
  timing?: Partial<BrowserAudioTiming>;
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

function defaultLimits(): BrowserAudioLimits {
  return {
    maxMs: env.browserRecordingMaxMin * 60_000,
    silenceMs: env.browserRecordingSilenceStopMin * 60_000,
    unreachableMs: env.browserRecordingUnreachableStopMin * 60_000,
  };
}

const DEFAULT_TIMING: BrowserAudioTiming = {
  reconnectMinMs: 2_000,
  reconnectMaxMs: 60_000,
  checkEveryMs: 5_000,
  rowCheckEveryMs: 60_000,
  logEveryMs: 60_000,
  wait,
};

/** Remote Browser's audio route is configured for this deployment. */
export function browserAudioConfigured(): boolean {
  return Boolean(env.remoteBrowserAudioUrl && env.remoteBrowserAudioTapKey);
}

function problemFor(status: number, code: unknown): BrowserAudioProblem {
  if (code === 'no_browser' || code === 'no_audio' || code === 'busy') return code;
  if (status === 401) return 'unauthorized';
  return 'unavailable';
}

function isSound(samples: Float32Array): boolean {
  if (samples.length === 0) return false;
  let sum = 0;
  for (const v of samples) sum += v * v;
  return Math.sqrt(sum / samples.length) >= SOUND_RMS;
}

export class BrowserAudioListener {
  private state: BrowserAudioState = 'connecting';
  private problem: BrowserAudioProblem | undefined;
  private endReason: BrowserAudioEndReason | undefined;
  private readonly abort = new AbortController();
  private readonly now: () => number;
  private readonly limits: BrowserAudioLimits;
  private readonly timing: BrowserAudioTiming;
  private readonly startedAt: number;
  /** Where the longest-recording limit counts from. */
  private readonly recordingStartedAt: number;
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
  /** The last push loud enough to be sound (starts as the start: a call silent from the outset counts too). */
  private lastSoundAt: number;
  /** Since when the Room browser's audio has not been reached; null while a stream is open. */
  private unreachableSince: number | null;
  private reconnectMs: number;
  private failuresSinceLog = 0;
  private lastFailureLogAt = Number.NEGATIVE_INFINITY;
  private lastRowCheckAt: number;
  private goneChecks = 0;
  private checking = false;
  private ending = false;
  private readonly watchdog: ReturnType<typeof setInterval>;

  constructor(
    private readonly ctx: BrowserAudioContext,
    /** Told once, when this listener stopped for good (by itself or by `stop()`). */
    private readonly onEnded: (listener: BrowserAudioListener) => void = () => undefined,
  ) {
    this.now = ctx.now ?? Date.now;
    this.limits = { ...defaultLimits(), ...ctx.limits };
    this.timing = { ...DEFAULT_TIMING, ...ctx.timing };
    this.startedAt = this.now();
    this.recordingStartedAt = Number.isFinite(ctx.recordingStartedAt) ? Math.min(ctx.recordingStartedAt!, this.startedAt) : this.startedAt;
    this.lastSoundAt = this.startedAt;
    this.unreachableSince = this.startedAt;
    this.lastRowCheckAt = this.startedAt;
    this.reconnectMs = this.timing.reconnectMinMs;
    this.session = liveSessionFor(ctx.meetingId, env.liveMaxConcurrentRecordings);
    if (!this.session) {
      throw new AppError(`The app is already captioning the maximum of ${env.liveMaxConcurrentRecordings} meetings.`, 'CAPACITY_REACHED');
    }
    this.session.attributeSpeaker ??= createLocalSpeakerAttributor(ctx);
    this.startEncoder();
    this.watchdog = setInterval(() => {
      this.check().catch((error) => console.warn('[browser-audio] check failed:', ctx.meetingId, error instanceof Error ? error.message : error));
    }, this.timing.checkEveryMs);
    this.watchdog.unref?.();
    this.loop = this.run();
  }

  get meetingId(): string {
    return this.ctx.meetingId;
  }

  status(): BrowserAudioStatus {
    return {
      state: this.state,
      ...(this.problem ? { problem: this.problem } : {}),
      heardSec: Math.round((this.fedBytes / BYTES_PER_SECOND) * 10) / 10,
      partsUploaded: this.partSeq,
      ...(this.endReason ? { endReason: this.endReason } : {}),
    };
  }

  captionsSince(cursor: number) {
    return { ...this.session!.captionsSince(cursor), degraded: this.session!.degraded };
  }

  /** Stops listening, feeds what is left, and uploads the last part. Resolves when every part is saved. */
  async stop(): Promise<void> {
    if (this.state === 'stopped') return this.uploads;
    this.state = 'stopped';
    clearInterval(this.watchdog);
    this.abort.abort();
    await this.loop.catch(() => undefined);
    await this.flushPending();
    await this.finishEncoder();
    await this.uploads;
    this.onEnded(this);
  }

  /** Checks the limits and, now and then, the meeting row. Exposed for tests; the watchdog calls it. */
  async check(): Promise<void> {
    if (this.state === 'stopped' || this.ending || this.checking) return;
    this.checking = true;
    try {
      const now = this.now();
      const reason: BrowserAudioEndReason | null =
        now - this.recordingStartedAt >= this.limits.maxMs
          ? 'max_duration'
          : this.unreachableSince !== null && now - this.unreachableSince >= this.limits.unreachableMs
            ? 'unreachable'
            : now - this.lastSoundAt >= this.limits.silenceMs
              ? 'silence'
              : null;
      if (reason) {
        await this.stopByItself(reason);
        return;
      }
      if (now - this.lastRowCheckAt >= this.timing.rowCheckEveryMs) {
        this.lastRowCheckAt = now;
        await this.checkMeetingRow();
      }
    } finally {
      this.checking = false;
    }
  }

  private async stopByItself(reason: BrowserAudioEndReason): Promise<void> {
    if (this.ending || this.state === 'stopped') return;
    this.ending = true;
    this.endReason = reason;
    console.warn(`[browser-audio] stopping by itself (${reason}): meeting=${this.ctx.meetingId} heardSec=${this.status().heardSec}`);
    await this.stop();
    try {
      await this.ctx.onAutoStop?.(reason, this.status());
    } catch (error) {
      console.warn('[browser-audio] ending the meeting after an automatic stop failed:', this.ctx.meetingId, error instanceof Error ? error.message : error);
    }
  }

  /** The meeting was deleted, or ended another way (a tab's End, the startup sweep): stop listening, nothing more. */
  private async checkMeetingRow(): Promise<void> {
    let row: Awaited<ReturnType<AppDbBotClient['getById']>>;
    try {
      row = await this.ctx.db.getById('meetings', 'room', this.ctx.meetingId);
    } catch {
      return; // The Hub did not answer: ask again next time.
    }
    const gone = !row || row.status !== 'recording';
    this.goneChecks = gone ? this.goneChecks + 1 : 0;
    if (this.goneChecks < GONE_CHECKS || this.ending || this.state === 'stopped') return;
    this.ending = true;
    console.warn(`[browser-audio] the meeting is ${row ? `"${String(row.status)}"` : 'gone'}, stopped listening: meeting=${this.ctx.meetingId}`);
    await this.stop();
  }

  private async run(): Promise<void> {
    while (!this.abort.signal.aborted) {
      try {
        await this.listenOnce();
      } catch (error) {
        if (this.abort.signal.aborted) return;
        if (!this.problem) this.problem = 'unavailable';
        this.noteUnreachable(error instanceof Error ? error.message : String(error));
      }
      if (this.abort.signal.aborted) return;
      this.state = 'waiting';
      await this.timing.wait(this.reconnectMs, this.abort.signal);
      this.reconnectMs = Math.min(this.reconnectMs * 2, this.timing.reconnectMaxMs);
    }
  }

  /** One failed or ended attempt: counted from the first one, logged the first time and then at most once per `logEveryMs`. */
  private noteUnreachable(detail: string): void {
    this.unreachableSince ??= this.now();
    this.failuresSinceLog += 1;
    const now = this.now();
    if (now - this.lastFailureLogAt < this.timing.logEveryMs) return;
    const more = this.failuresSinceLog > 1 ? ` (${this.failuresSinceLog} attempts since the last line)` : '';
    console.warn(`[browser-audio] cannot hear the Room browser, retrying in ${Math.round(this.reconnectMs / 1000)} s: meeting=${this.ctx.meetingId} ${detail}${more}`);
    this.lastFailureLogAt = now;
    this.failuresSinceLog = 0;
  }

  private async listenOnce(): Promise<void> {
    const url = `${env.remoteBrowserAudioUrl!.replace(/\/+$/, '')}/audio-tap?roomId=${encodeURIComponent(this.ctx.roomId)}`;
    const response = await fetch(url, { headers: { Authorization: `Bearer ${env.remoteBrowserAudioTapKey}` }, signal: this.abort.signal });
    if (!response.ok || !response.body) {
      const body = (await response.json().catch(() => null)) as { code?: unknown } | null;
      this.problem = problemFor(response.status, body?.code);
      this.state = 'waiting';
      this.noteUnreachable(`HTTP ${response.status} ${this.problem}`);
      return;
    }
    this.problem = undefined;
    this.state = 'listening';
    this.unreachableSince = null;
    if (this.failuresSinceLog > 0 || Number.isFinite(this.lastFailureLogAt)) {
      console.warn(`[browser-audio] hearing the Room browser again: meeting=${this.ctx.meetingId}`);
      this.failuresSinceLog = 0;
      this.lastFailureLogAt = Number.NEGATIVE_INFINITY;
    }
    let delivered = false;
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      if (this.abort.signal.aborted) return;
      // A stream that brings audio resets the backoff; one that opens and closes at once does not.
      if (!delivered) {
        delivered = true;
        this.reconnectMs = this.timing.reconnectMinMs;
      }
      await this.take(Buffer.from(chunk));
    }
    if (this.abort.signal.aborted) return;
    this.problem = 'no_browser';
    this.noteUnreachable('the stream ended');
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
    if (isSound(samples)) this.lastSoundAt = this.now();
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
const ended = new Map<string, { status: BrowserAudioStatus; at: number }>();

function forget(listener: BrowserAudioListener): void {
  if (listeners.get(listener.meetingId) === listener) listeners.delete(listener.meetingId);
  const now = Date.now();
  for (const [meetingId, entry] of ended) if (now - entry.at > ENDED_KEEP_MS) ended.delete(meetingId);
  ended.set(listener.meetingId, { status: listener.status(), at: now });
}

/** Starts (or returns the running) listener for this meeting. A listener that ended is never started again for the same meeting. */
export function startBrowserAudio(ctx: BrowserAudioContext): BrowserAudioListener {
  if (!browserAudioConfigured()) throw new AppError('Listening through the Room browser is not set up on this deployment.', 'PROVIDER_NOT_CONFIGURED');
  const existing = listeners.get(ctx.meetingId);
  if (existing) return existing;
  const before = ended.get(ctx.meetingId);
  if (before && Date.now() - before.at <= ENDED_KEEP_MS) throw new AppError('This recording has ended.', 'INVALID_STATE');
  const listener = new BrowserAudioListener(ctx, forget);
  listeners.set(ctx.meetingId, listener);
  return listener;
}

export function browserAudioFor(meetingId: string): BrowserAudioListener | undefined {
  return listeners.get(meetingId);
}

/** How this meeting's listener ended (within the last hour), e.g. `endReason` when it stopped by itself. */
export function browserAudioEnded(meetingId: string): BrowserAudioStatus | undefined {
  const entry = ended.get(meetingId);
  return entry && Date.now() - entry.at <= ENDED_KEEP_MS ? entry.status : undefined;
}

/** Stops the meeting's listener, if any, once its last part is saved. Safe to call twice. */
export async function stopBrowserAudio(meetingId: string): Promise<BrowserAudioStatus | undefined> {
  const listener = listeners.get(meetingId);
  if (!listener) return undefined;
  try {
    await listener.stop();
    return listener.status();
  } finally {
    if (listeners.get(meetingId) === listener) listeners.delete(meetingId);
  }
}

/** Test-only: forget every listener and every ended one. */
export function resetBrowserAudioForTests(): void {
  listeners.clear();
  ended.clear();
}
