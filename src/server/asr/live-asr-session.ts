/**
 * Live captions for the `local` provider. The iframe pushes 16 kHz PCM every
 * ~500 ms (`meeting_audio_push`); each meeting has one session here: a Silero
 * VAD cuts the stream into utterances, each finished utterance is recognised
 * in the background (in order) and becomes one final caption. A push answers
 * with the captions the client has not seen yet (`cursor`), so there is no
 * separate poll; a caption shows ~0.4 s silence + decode + one push interval
 * after the speaker stops.
 *
 * In memory, one replica (like the speaker registry). A restart loses the
 * session; the client simply keeps pushing and a new one starts. The stored
 * transcript never depends on this — it comes from the 60 s parts.
 */
import type { Vad } from 'sherpa-onnx-node';

import { createVad, recognizeUtterance, SAMPLE_RATE, type AsrLanguage } from './asr-engine.js';

const WINDOW = 512;
/** A push whose start is this far from where the stream left off (pause, lost chunks) re-anchors the clock. */
const REANCHOR_SEC = 1;
/** A session with no push for this long is dropped. */
const IDLE_TTL_MS = 60_000;
/** Captions kept per session for clients catching up. */
const MAX_CAPTIONS = 2_000;

export interface LiveCaption {
  /** Position in the session; a client's `cursor` is the next index it wants. */
  index: number;
  id: string;
  text: string;
  /** Meeting clock (seconds since the recorder epoch). */
  atSec: number;
  endSec: number;
  lang: AsrLanguage;
}

/** What a session needs from the engine — injectable so tests run without models. */
export interface LiveAsrEngine {
  createVad(): Promise<Pick<Vad, 'acceptWaveform' | 'isEmpty' | 'front' | 'pop' | 'flush' | 'reset'>>;
  recognize(samples: Float32Array, offsetSec: number): Promise<{ text: string; lang: AsrLanguage }>;
}

const defaultEngine: LiveAsrEngine = {
  createVad,
  recognize: (samples, offsetSec) => recognizeUtterance(samples, offsetSec),
};

export class LiveAsrSession {
  private vad: Awaited<ReturnType<LiveAsrEngine['createVad']>> | null = null;
  private lastSeq = -1;
  private originSec: number | null = null;
  private samplesFed = 0;
  private carry = new Float32Array(0);
  private readonly captions: LiveCaption[] = [];
  private nextIndex = 0;
  /** Serial decode chain: utterances are recognised one after another, captions stay in order. */
  private decoding: Promise<void> = Promise.resolve();
  degraded = false;
  lastActivityMs = Date.now();

  constructor(
    readonly meetingId: string,
    private readonly engine: LiveAsrEngine = defaultEngine,
  ) {}

  /**
   * Feeds one chunk. `seq` makes it idempotent: a chunk at or below the last
   * accepted seq is ignored (a retried push), a jump marks the session
   * degraded (audio lost) and re-anchors on `chunkStartSec`.
   */
  async push(seq: number, chunkStartSec: number, pcm: Float32Array): Promise<void> {
    this.lastActivityMs = Date.now();
    if (seq <= this.lastSeq) return;
    if (this.lastSeq >= 0 && seq > this.lastSeq + 1) this.degraded = true;
    this.lastSeq = seq;
    this.vad ??= await this.engine.createVad();

    const expectedSec = this.originSec === null ? null : this.originSec + (this.samplesFed + this.carry.length) / SAMPLE_RATE;
    if (expectedSec === null || Math.abs(chunkStartSec - expectedSec) > REANCHOR_SEC) this.reanchor(chunkStartSec);

    const input = new Float32Array(this.carry.length + pcm.length);
    input.set(this.carry);
    input.set(pcm, this.carry.length);
    let offset = 0;
    for (; offset + WINDOW <= input.length; offset += WINDOW) {
      this.vad.acceptWaveform(input.subarray(offset, offset + WINDOW));
      this.samplesFed += WINDOW;
      this.drain();
    }
    this.carry = input.slice(offset);
  }

  /** Captions from `cursor` on, and the cursor to send next time. */
  captionsSince(cursor: number): { captions: LiveCaption[]; cursor: number } {
    const fresh = this.captions.filter((caption) => caption.index >= cursor);
    return { captions: fresh, cursor: this.nextIndex };
  }

  /** Flushes the pending utterance and waits for every decode (end of recording, tests). */
  async finish(): Promise<void> {
    if (this.vad) {
      this.vad.flush();
      this.drain();
    }
    await this.decoding;
  }

  private reanchor(chunkStartSec: number): void {
    if (this.vad && this.originSec !== null) {
      this.vad.flush();
      this.drain();
      this.vad.reset();
    }
    this.originSec = chunkStartSec;
    this.samplesFed = 0;
    this.carry = new Float32Array(0);
  }

  private drain(): void {
    if (!this.vad || this.originSec === null) return;
    const origin = this.originSec;
    while (!this.vad.isEmpty()) {
      const segment = this.vad.front(false);
      this.vad.pop();
      const samples = segment.samples.slice();
      const atSec = origin + segment.start / SAMPLE_RATE;
      const endSec = atSec + samples.length / SAMPLE_RATE;
      this.decoding = this.decoding
        .then(async () => {
          const result = await this.engine.recognize(samples, atSec);
          if (!result.text) return;
          const index = this.nextIndex++;
          this.captions.push({ index, id: `${this.meetingId}:local:${index}`, text: result.text, atSec, endSec, lang: result.lang });
          if (this.captions.length > MAX_CAPTIONS) this.captions.splice(0, this.captions.length - MAX_CAPTIONS);
        })
        .catch((error: unknown) => {
          this.degraded = true;
          console.warn('[live-asr] utterance failed:', this.meetingId, error instanceof Error ? error.message : error);
        });
    }
  }
}

const sessions = new Map<string, LiveAsrSession>();

/** Drops sessions idle past the TTL; returns how many are left. */
export function sweepIdleSessions(nowMs = Date.now()): number {
  for (const [meetingId, session] of sessions) {
    if (nowMs - session.lastActivityMs > IDLE_TTL_MS) sessions.delete(meetingId);
  }
  return sessions.size;
}

/** The meeting's session, created on first use; `null` when a new one would exceed `maxSessions`. */
export function liveSessionFor(meetingId: string, maxSessions: number, engine?: LiveAsrEngine): LiveAsrSession | null {
  const existing = sessions.get(meetingId);
  if (existing) return existing;
  if (sweepIdleSessions() >= maxSessions) return null;
  const session = new LiveAsrSession(meetingId, engine);
  sessions.set(meetingId, session);
  return session;
}

/** Ends a meeting's live session (processing started). */
export function closeLiveSession(meetingId: string): void {
  sessions.delete(meetingId);
}

export function activeLiveSessionCount(): number {
  return sweepIdleSessions();
}

/** Test-only. */
export function resetLiveSessionsForTests(): void {
  sessions.clear();
}

/** Little-endian PCM16 bytes → float samples in [-1, 1]. */
export function pcm16ToFloat32(bytes: Buffer): Float32Array {
  const count = Math.floor(bytes.length / 2);
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) out[i] = bytes.readInt16LE(i * 2) / 32768;
  return out;
}
