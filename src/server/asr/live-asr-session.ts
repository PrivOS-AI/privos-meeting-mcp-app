/**
 * Live captions for the `local` provider. The iframe pushes 16 kHz PCM every
 * ~500 ms (`meeting_audio_push`); each meeting has one session here: a Silero
 * VAD cuts the stream into utterances, each finished utterance is recognised
 * in the background (in order) and becomes one final caption. A push answers
 * with the captions the client has not seen yet (`cursor`), so there is no
 * separate poll; a caption shows ~0.4 s silence + decode after the speaker stops
 * (a push waits briefly for that decode instead of leaving it to the next one).
 * While someone is still talking, the speech so far is decoded about once a
 * second as a `draft` (one model, the language last heard), which the final
 * caption replaces.
 *
 * In memory, one replica (like the speaker registry). A restart loses the
 * session; the client simply keeps pushing and a new one starts. The stored
 * transcript never depends on this — it comes from the 60 s parts.
 */
import type { Vad } from 'sherpa-onnx-node';

import { createVad, recognizeDraft, recognizeUtterance, SAMPLE_RATE, type AsrLanguage } from './asr-engine.js';

const WINDOW = 512;
/** A push whose start is this far from where the stream left off (pause, lost chunks) re-anchors the clock. */
const REANCHOR_SEC = 1;
/** A session with no push for this long is dropped. */
const IDLE_TTL_MS = 60_000;
/** Captions kept per session for clients catching up. */
const MAX_CAPTIONS = 2_000;
/** A new draft at most this often, and only once this much speech is in. */
const DRAFT_EVERY_SEC = 1;
const DRAFT_MIN_SEC = 0.6;
/** A draft decodes at most the last this many seconds (a long utterance is cut at 10 s anyway). */
const DRAFT_WINDOW_SEC = 10;
/** The VAD confirms speech ~0.25 s in; the draft starts a little before that. */
const DRAFT_LEAD_SEC = 0.3;

/** The speech in progress, decoded so far; replaced by the final caption. */
export interface LiveDraft {
  id: string;
  text: string;
  atSec: number;
  endSec: number;
  lang: AsrLanguage;
}

export interface LiveCaption {
  /** Position in the session; a client's `cursor` is the next index it wants. */
  index: number;
  id: string;
  text: string;
  /** Meeting clock (seconds since the recorder epoch). */
  atSec: number;
  endSec: number;
  lang: AsrLanguage;
  /** The live session speaker who said it, when the session has an attributor and it could tell. */
  speakerKey?: string;
}

/** Decides who said a finished utterance (`live-speakers/local-attribution.ts`); injected so this module stays free of speaker code. */
export interface SpeakerAttributor {
  (utterance: { index: number; samples: Float32Array; atSec: number; endSec: number }): Promise<string | undefined>;
  /** Persists what the attributor still holds; awaited before the post-meeting job reads it. */
  flush(): Promise<void>;
}

/** What a session needs from the engine — injectable so tests run without models. */
export interface LiveAsrEngine {
  createVad(): Promise<Pick<Vad, 'acceptWaveform' | 'isEmpty' | 'front' | 'pop' | 'flush' | 'reset'> & Partial<Pick<Vad, 'isDetected'>>>;
  recognize(samples: Float32Array, offsetSec: number): Promise<{ text: string; lang: AsrLanguage }>;
  /** Optional: without it (or a VAD without `isDetected`) the session emits no drafts. */
  recognizeDraft?(samples: Float32Array, lang: AsrLanguage): Promise<string>;
}

const defaultEngine: LiveAsrEngine = {
  createVad,
  recognize: (samples, offsetSec) => recognizeUtterance(samples, offsetSec),
  recognizeDraft,
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
  /** Utterances drained but not yet decoded; a draft never competes with them for the CPU. */
  private pendingFinals = 0;
  /** The last ~10 s of audio fed to the VAD; `recentStart` is its first sample's `samplesFed` position. */
  private recent = new Float32Array(0);
  private recentStart = 0;
  /** `samplesFed` position where the speech in progress started; `null` while nobody talks. */
  private speechStart: number | null = null;
  private lastDraftAt = 0;
  private draftRun: Promise<void> | null = null;
  private draft: LiveDraft | null = null;
  private lastLang: AsrLanguage = 'vi';
  degraded = false;
  lastActivityMs = Date.now();
  /** Set once by the push tool; without it captions carry no speaker. */
  attributeSpeaker: SpeakerAttributor | null = null;

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
      if (this.speechStart === null && this.vad.isDetected?.()) {
        this.speechStart = Math.max(0, this.samplesFed - Math.round(DRAFT_LEAD_SEC * SAMPLE_RATE));
      }
    }
    this.remember(input.subarray(0, offset));
    this.carry = input.slice(offset);
    this.maybeDraft();
  }

  /** Resolves once the decodes queued so far are done, or after `timeoutMs`, whichever is first. */
  async settle(timeoutMs: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });
    await Promise.race([Promise.all([this.decoding, this.draftRun ?? Promise.resolve()]), timeout]);
    clearTimeout(timer);
  }

  private remember(fed: Float32Array): void {
    const merged = new Float32Array(this.recent.length + fed.length);
    merged.set(this.recent);
    merged.set(fed, this.recent.length);
    this.recent = merged.slice(Math.max(0, merged.length - DRAFT_WINDOW_SEC * SAMPLE_RATE));
    this.recentStart = this.samplesFed - this.recent.length;
  }

  private maybeDraft(): void {
    const decodeDraft = this.engine.recognizeDraft;
    if (!decodeDraft || this.speechStart === null || this.draftRun || this.pendingFinals > 0 || this.originSec === null) return;
    if (this.samplesFed - this.speechStart < DRAFT_MIN_SEC * SAMPLE_RATE) return;
    if (this.samplesFed - this.lastDraftAt < DRAFT_EVERY_SEC * SAMPLE_RATE) return;
    const from = Math.max(this.speechStart, this.recentStart);
    const samples = this.recent.slice(from - this.recentStart);
    const utterance = this.speechStart;
    const atSec = this.originSec + from / SAMPLE_RATE;
    const endSec = this.originSec + this.samplesFed / SAMPLE_RATE;
    const lang = this.lastLang;
    this.lastDraftAt = this.samplesFed;
    this.draftRun = decodeDraft(samples, lang)
      .then((text) => {
        // The utterance may have ended (and its final been queued) while this decoded.
        if (this.speechStart === utterance && text) this.draft = { id: `${this.meetingId}:local:draft`, text, atSec, endSec, lang };
      })
      .catch((error: unknown) => console.warn('[live-asr] draft failed:', this.meetingId, error instanceof Error ? error.message : error))
      .finally(() => {
        this.draftRun = null;
      });
  }

  /** Captions from `cursor` on, and the cursor to send next time. */
  captionsSince(cursor: number): { captions: LiveCaption[]; cursor: number; draft: LiveDraft | null } {
    const fresh = this.captions.filter((caption) => caption.index >= cursor);
    return { captions: fresh, cursor: this.nextIndex, draft: this.draft };
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
    this.recent = new Float32Array(0);
    this.recentStart = 0;
    this.speechStart = null;
    this.lastDraftAt = 0;
    this.draft = null;
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
      // The utterance is complete: its draft goes and the final takes over. A cut at the
      // 10 s limit leaves the VAD in speech, so the next draft starts right here.
      this.speechStart = this.vad.isDetected?.() ? this.samplesFed : null;
      this.lastDraftAt = this.samplesFed;
      this.draft = null;
      this.pendingFinals++;
      this.decoding = this.decoding
        .then(async () => {
          const result = await this.engine.recognize(samples, atSec);
          this.lastLang = result.lang;
          if (!result.text) return;
          const index = this.nextIndex++;
          // Speaker attribution never costs the caption: a failure just leaves it unattributed.
          const speakerKey = this.attributeSpeaker ? await this.attributeSpeaker({ index, samples, atSec, endSec }).catch(() => undefined) : undefined;
          this.captions.push({ index, id: `${this.meetingId}:local:${index}`, text: result.text, atSec, endSec, lang: result.lang, ...(speakerKey ? { speakerKey } : {}) });
          if (this.captions.length > MAX_CAPTIONS) this.captions.splice(0, this.captions.length - MAX_CAPTIONS);
        })
        .catch((error: unknown) => {
          this.degraded = true;
          console.warn('[live-asr] utterance failed:', this.meetingId, error instanceof Error ? error.message : error);
        })
        .finally(() => {
          this.pendingFinals--;
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

/**
 * Recording is over: recognises what is still buffered, writes the live speakers the session
 * attributed (the post-meeting job reads them next), then drops the session. Never throws.
 */
export async function finishLiveSession(meetingId: string): Promise<void> {
  const session = sessions.get(meetingId);
  if (!session) return;
  try {
    await session.finish();
    await session.attributeSpeaker?.flush();
  } catch (error) {
    console.warn('[live-asr] finishing the live session failed:', meetingId, error instanceof Error ? error.message : error);
  } finally {
    closeLiveSession(meetingId);
  }
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
