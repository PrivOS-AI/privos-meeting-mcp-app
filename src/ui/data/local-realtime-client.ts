/**
 * Live captions from the app's own recognizer (`local` provider). The iframe
 * cannot reach the container directly, so audio goes through the host bridge:
 * the meeting's `MediaStream` is tapped with WebAudio, downsampled to 16 kHz
 * mono, and sent every ~250 ms as PCM16 to `meeting_audio_push`.
 *
 * Two independent paths, so neither waits for the other's relay round trip
 * (~1 s):
 *  - audio: up to `MAX_IN_FLIGHT` pushes travel at once (the server feeds them
 *    in `seq` order); a push only feeds audio and answers at once;
 *  - captions: `meeting_captions_wait` requests held open answer the moment a
 *    caption or a new draft is decoded (two, staggered: `runCaptionWaits`).
 *
 * A failed push keeps its chunk and is sent again (same `seq`, so the server
 * never feeds it twice); the backlog is capped, and audio dropped past the cap
 * just costs captions — the recording is separate.
 */
import type { CaptionEvent, RealtimeConnection, RealtimeConnectionOptions } from './realtime-client.js';

const TARGET_RATE = 16_000;
const PUSH_INTERVAL_MS = 250;
/** Pushes travelling at once: enough to keep audio flowing through a ~1 s relay round trip. */
const MAX_IN_FLIGHT = 3;
/** A push carries at least this much audio (except the last one), at most ~4 s (the server's 128 KB cap). */
const MIN_PUSH_SAMPLES = TARGET_RATE * 0.2;
const MAX_PUSH_SAMPLES = TARGET_RATE * 4;
/** Unsent audio kept while pushes fail, ~20 s. */
const MAX_BACKLOG_SAMPLES = TARGET_RATE * 20;
const PROCESSOR_FRAMES = 4096;
/** How long one caption wait is held open on the server. */
const CAPTION_WAIT_MS = 5_000;
/**
 * Two waits are kept open, the second about half a relay round trip behind the
 * first: while one answer travels back, the other is already waiting on the
 * server, so a caption decoded at that moment does not wait for a new request.
 * Measured with scripts/eval-caption-relay.ts: final captions ~0.15 s sooner.
 */
const CAPTION_WAITERS = 2;
const WAITER_STAGGER_MS = 500;

export interface AudioPushRequest {
  seq: number;
  chunkStartSec: number;
  sampleRate: number;
  pcm: string;
  cursor: number;
  /** false: the push only feeds audio (captions come from `meeting_captions_wait`). */
  captions?: boolean;
}

export interface CaptionsWaitRequest {
  cursor: number;
  draftRev: number;
  waitMs: number;
}

export interface AudioPushResponse {
  /** `speakerKey` is the live session speaker the server attributed the utterance to, when it could tell. */
  captions: Array<{ index: number; id: string; text: string; atSec: number; endSec: number; lang: string; speakerKey?: string }>;
  cursor: number;
  degraded?: boolean;
  /** The speech still in progress; `null` once it ended (its final is in `captions`) or nobody talks. */
  draft?: { id: string; text: string; atSec: number; endSec: number; lang: string } | null;
  /** Revision of `draft`, for the next caption wait. */
  draftRev?: number;
}

/** Averages `input` (at `inputRate`) down to 16 kHz. Carries the fractional position across calls. */
export class Downsampler {
  private position = 0;
  private readonly ratio: number;

  constructor(inputRate: number) {
    this.ratio = inputRate / TARGET_RATE;
  }

  process(input: Float32Array): Float32Array {
    if (this.ratio === 1) return input.slice();
    const out: number[] = [];
    while (this.position + this.ratio <= input.length) {
      const from = Math.floor(this.position);
      const to = Math.min(input.length, Math.floor(this.position + this.ratio));
      let sum = 0;
      for (let i = from; i < to; i++) sum += input[i];
      out.push(to > from ? sum / (to - from) : input[from]);
      this.position += this.ratio;
    }
    this.position -= input.length;
    return Float32Array.from(out);
  }
}

/** Float samples in [-1, 1] → base64 little-endian PCM16. */
export function floatToPcm16Base64(samples: Float32Array): string {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  samples.forEach((sample, i) => view.setInt16(i * 2, Math.max(-32768, Math.min(32767, Math.round(sample * 32767))), true));
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/**
 * Turns one answer of the server's live session (finals since the cursor, plus
 * the draft of speech still in progress) into caption events. Shared by the
 * microphone path (`meeting_audio_push`) and the Room-browser path
 * (`meeting_browser_audio` poll), which read the same session.
 */
export function createCaptionEmitter(onCaption: RealtimeConnectionOptions['onCaption']): (response: Pick<AudioPushResponse, 'captions' | 'draft'>) => void {
  /** Id of the draft line on screen, if any. */
  let shownDraft: string | null = null;
  /** Finals already shown: two caption waits can both hand over the same one. */
  const shownFinals = new Set<string>();
  return (response) => {
    for (const caption of response.captions) {
      if (shownFinals.has(caption.id)) continue;
      shownFinals.add(caption.id);
      const event: CaptionEvent = { kind: 'final', id: caption.id, text: caption.text, atSec: caption.atSec, endSec: caption.endSec, lang: caption.lang, ...(caption.speakerKey ? { speakerKey: caption.speakerKey } : {}) };
      onCaption(event);
    }
    const draft = response.draft ?? null;
    if (draft) {
      onCaption({ kind: 'draft', id: draft.id, text: draft.text, atSec: draft.atSec, endSec: draft.endSec, lang: draft.lang });
      shownDraft = draft.id;
    } else if (shownDraft && response.captions.length === 0) {
      // Speech that came to nothing (a cough, noise): clear the draft. A new final replaces it on its own.
      onCaption({ kind: 'draft', id: shownDraft, text: '', atSec: 0, endSec: 0 });
      shownDraft = null;
    } else {
      shownDraft = null;
    }
  };
}

/**
 * How late captions show, measured where it matters (on screen, meeting clock):
 * the first draft of each utterance after its speech started, each final after
 * the speaker stopped. Logged to the console every 10 finals as medians.
 */
export function createLatencyMeter(recorderEpochMs: number, label: string): (response: Pick<AudioPushResponse, 'captions' | 'draft'>) => void {
  const draftLags: number[] = [];
  const finalLags: number[] = [];
  const seenDrafts = new Set<number>();
  const seenFinals = new Set<string>();
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  return (response) => {
    const nowSec = (performance.now() - recorderEpochMs) / 1000;
    const draft = response.draft;
    if (draft && !seenDrafts.has(Math.round(draft.atSec * 10))) {
      seenDrafts.add(Math.round(draft.atSec * 10));
      draftLags.push(nowSec - draft.atSec);
    }
    let added = 0;
    for (const caption of response.captions) {
      if (seenFinals.has(caption.id)) continue;
      seenFinals.add(caption.id);
      finalLags.push(nowSec - caption.endSec);
      added++;
    }
    if (added > 0 && finalLags.length % 10 === 0) {
      const last = (xs: number[]) => xs.slice(-30);
      console.info(`[captions:${label}] first draft ${median(last(draftLags))?.toFixed(2) ?? '–'} s after speech starts, final ${median(last(finalLags)).toFixed(2)} s after it stops (median of the last ${last(finalLags).length})`);
    }
  };
}

/** `promise`, or a rejection after `ms`: ending a meeting never hangs on a stalled request. */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Keeps `CAPTION_WAITERS` caption waits open until `isClosed()`, handing each answer to
 * `onAnswer`. `position()` is the client's cursor and draft revision at the time of asking.
 */
export function runCaptionWaits(
  waitCaptions: (request: CaptionsWaitRequest) => Promise<AudioPushResponse>,
  position: () => { cursor: number; draftRev: number },
  onAnswer: (response: AudioPushResponse) => void,
  isClosed: () => boolean,
): void {
  for (let waiter = 0; waiter < CAPTION_WAITERS; waiter++) {
    void (async () => {
      if (waiter > 0) await new Promise((resolve) => setTimeout(resolve, WAITER_STAGGER_MS * waiter));
      while (!isClosed()) {
        try {
          const response = await waitCaptions({ ...position(), waitMs: CAPTION_WAIT_MS });
          if (!isClosed()) onAnswer(response);
          // The staggered waiter stays behind the first one instead of falling into step with it.
          if (waiter > 0) await new Promise((resolve) => setTimeout(resolve, WAITER_STAGGER_MS * waiter));
        } catch {
          if (!isClosed()) await new Promise((resolve) => setTimeout(resolve, 1_000));
        }
      }
    })();
  }
}

export interface LocalConnectionOptions extends RealtimeConnectionOptions {
  pushAudio: (request: AudioPushRequest) => Promise<AudioPushResponse>;
  /** Long-polls the captions; without it captions ride the push answers, one push at a time. */
  waitCaptions?: (request: CaptionsWaitRequest) => Promise<AudioPushResponse>;
}

interface Chunk {
  seq: number;
  startSec: number;
  samples: Float32Array;
}

export function createLocalConnection(opts: RealtimeConnectionOptions): RealtimeConnection {
  const { pushAudio, waitCaptions } = opts as Partial<LocalConnectionOptions>;
  if (!pushAudio) throw new Error('The local caption client needs pushAudio.');
  const maxInFlight = waitCaptions ? MAX_IN_FLIGHT : 1;

  const context = new AudioContext();
  const source = context.createMediaStreamSource(opts.stream);
  const processor = context.createScriptProcessor(PROCESSOR_FRAMES, 1, 1);
  const mute = context.createGain();
  mute.gain.value = 0;
  const downsampler = new Downsampler(context.sampleRate);

  let pending = new Float32Array(0);
  /** Meeting-clock second of `pending[0]`. */
  let pendingStartSec: number | null = null;
  /** Cut but not yet accepted by the server, in seq order (a failed push goes back here). */
  let unsent: Chunk[] = [];
  let nextSeq = 0;
  let inFlight = 0;
  let cursor = 0;
  let draftRev = 0;
  let stopped = false;
  let closed = false;
  let live = false;
  /** After a failed push, nothing is sent for a moment: a down relay is not hammered three pushes at a time. */
  let pausedUntil = 0;

  processor.onaudioprocess = (event) => {
    if (stopped) return;
    const chunk = downsampler.process(event.inputBuffer.getChannelData(0));
    if (pendingStartSec === null) {
      // The callback fires once the buffer is full: its first sample was captured one buffer earlier.
      pendingStartSec = Math.max(0, (performance.now() - opts.recorderEpochMs) / 1000 - event.inputBuffer.duration);
    }
    const merged = new Float32Array(pending.length + chunk.length);
    merged.set(pending);
    merged.set(chunk, pending.length);
    pending = merged;
  };
  source.connect(processor);
  processor.connect(mute);
  mute.connect(context.destination);
  void context.resume();

  const showCaptions = createCaptionEmitter(opts.onCaption);
  const measure = createLatencyMeter(opts.recorderEpochMs, 'mic');
  const onCaptions = (response: AudioPushResponse) => {
    // Two waits answer independently: an older answer never moves the cursor back.
    if (response.cursor < cursor) return;
    cursor = response.cursor;
    if (typeof response.draftRev === 'number') draftRev = response.draftRev;
    showCaptions(response);
    measure(response);
  };
  const setLive = (ok: boolean, error?: unknown) => {
    if (ok && !live) opts.onStatus('live', { sessionIndex: 0 });
    if (!ok) opts.onStatus('reconnecting', { sessionIndex: 0, error: error instanceof Error ? error.message : String(error) });
    live = ok;
  };

  /** Cuts what was captured into a chunk; `all` takes even less than the minimum (stopping). */
  const cut = (all: boolean) => {
    while (pendingStartSec !== null && pending.length > 0 && (all || pending.length >= MIN_PUSH_SAMPLES)) {
      const take = Math.min(pending.length, MAX_PUSH_SAMPLES);
      unsent.push({ seq: nextSeq++, startSec: pendingStartSec, samples: pending.slice(0, take) });
      pending = pending.slice(take);
      pendingStartSec += take / TARGET_RATE;
    }
    // Pushes failing for a while: drop the oldest audio past the cap (the server notes the gap).
    let backlog = unsent.reduce((n, c) => n + c.samples.length, 0);
    while (backlog > MAX_BACKLOG_SAMPLES && unsent.length > 1) backlog -= unsent.shift()!.samples.length;
  };

  const send = (chunk: Chunk) => {
    inFlight++;
    pushAudio({ seq: chunk.seq, chunkStartSec: chunk.startSec, sampleRate: TARGET_RATE, pcm: floatToPcm16Base64(chunk.samples), cursor, ...(waitCaptions ? { captions: false } : {}) })
      .then((response) => {
        setLive(true);
        if (!waitCaptions) onCaptions(response);
      })
      .catch((error: unknown) => {
        // Back in line by seq; the next tick sends it again.
        unsent = [...unsent, chunk].sort((a, b) => a.seq - b.seq);
        pausedUntil = Date.now() + 1_000;
        setLive(false, error);
      })
      .finally(() => {
        inFlight--;
        pump();
      });
  };
  const pump = () => {
    if (Date.now() < pausedUntil) return;
    while (inFlight < maxInFlight && unsent.length > 0) send(unsent.shift()!);
  };

  const tick = () => {
    cut(false);
    pump();
  };


  opts.onStatus('connecting', { sessionIndex: 0 });
  opts.onStarted(0, 0);
  const timer = setInterval(tick, PUSH_INTERVAL_MS);
  if (waitCaptions) runCaptionWaits(waitCaptions, () => ({ cursor, draftRev }), onCaptions, () => closed);

  return {
    async stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      // Send what is left so the last utterance is recognised.
      cut(true);
      for (let attempt = 0; attempt < 3 && (unsent.length > 0 || inFlight > 0); attempt++) {
        pausedUntil = 0;
        pump();
        const deadline = Date.now() + 5_000;
        while (inFlight > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (waitCaptions) {
        // The last caption, if it is still being decoded.
        await withTimeout(waitCaptions({ cursor, draftRev, waitMs: 1_500 }).then(onCaptions), 2_500).catch(() => undefined);
      }
      closed = true;
      processor.disconnect();
      source.disconnect();
      mute.disconnect();
      await context.close().catch(() => undefined);
      opts.onStatus('off', { sessionIndex: 0 });
    },
  };
}
