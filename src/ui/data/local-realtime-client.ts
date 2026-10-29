/**
 * Live captions from the app's own recognizer (`local` provider). The iframe
 * cannot reach the container directly, so audio goes through the host bridge:
 * the meeting's `MediaStream` is tapped with WebAudio, downsampled to 16 kHz
 * mono, and sent every ~500 ms as PCM16 to `meeting_audio_push`, one push at a
 * time. Each answer carries the captions recognised since our cursor; they
 * arrive per utterance on the meeting clock, preceded by a `draft` of the
 * speech still in progress that the final replaces.
 *
 * A failed push keeps its chunk and is retried with the next one (same `seq`,
 * so the server never feeds it twice); the backlog is capped, and audio
 * dropped past the cap just costs captions — the recording is separate.
 */
import type { CaptionEvent, RealtimeConnection, RealtimeConnectionOptions } from './realtime-client.js';

const TARGET_RATE = 16_000;
const PUSH_INTERVAL_MS = 500;
/** At most ~4 s per push (the server's 128 KB cap): a push sends everything captured during the previous round trip. */
const MAX_PUSH_SAMPLES = TARGET_RATE * 4;
/** Unsent audio kept while pushes fail, ~20 s. */
const MAX_BACKLOG_SAMPLES = TARGET_RATE * 20;
const PROCESSOR_FRAMES = 4096;

export interface AudioPushRequest {
  seq: number;
  chunkStartSec: number;
  sampleRate: number;
  pcm: string;
  cursor: number;
}

export interface AudioPushResponse {
  /** `speakerKey` is the live session speaker the server attributed the utterance to, when it could tell. */
  captions: Array<{ index: number; id: string; text: string; atSec: number; endSec: number; lang: string; speakerKey?: string }>;
  cursor: number;
  degraded?: boolean;
  /** The speech still in progress; `null` once it ended (its final is in `captions`) or nobody talks. */
  draft?: { id: string; text: string; atSec: number; endSec: number; lang: string } | null;
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
  return (response) => {
    for (const caption of response.captions) {
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

export interface LocalConnectionOptions extends RealtimeConnectionOptions {
  pushAudio: (request: AudioPushRequest) => Promise<AudioPushResponse>;
}

export function createLocalConnection(opts: RealtimeConnectionOptions): RealtimeConnection {
  const pushAudio = (opts as Partial<LocalConnectionOptions>).pushAudio;
  if (!pushAudio) throw new Error('The local caption client needs pushAudio.');

  const context = new AudioContext();
  const source = context.createMediaStreamSource(opts.stream);
  const processor = context.createScriptProcessor(PROCESSOR_FRAMES, 1, 1);
  const mute = context.createGain();
  mute.gain.value = 0;
  const downsampler = new Downsampler(context.sampleRate);

  let pending = new Float32Array(0);
  /** Meeting-clock second of `pending[0]`. */
  let pendingStartSec: number | null = null;
  let seq = 0;
  let cursor = 0;
  let stopped = false;
  let inFlight = false;
  let live = false;

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
    const overflow = merged.length - MAX_BACKLOG_SAMPLES;
    if (overflow > 0) {
      pending = merged.slice(overflow);
      pendingStartSec += overflow / TARGET_RATE;
    } else {
      pending = merged;
    }
  };
  source.connect(processor);
  processor.connect(mute);
  mute.connect(context.destination);
  void context.resume();

  const showCaptions = createCaptionEmitter(opts.onCaption);

  const pushOnce = async (): Promise<void> => {
    if (inFlight || pendingStartSec === null || pending.length === 0) return;
    inFlight = true;
    const take = Math.min(pending.length, MAX_PUSH_SAMPLES);
    const samples = pending.subarray(0, take);
    try {
      const response = await pushAudio({ seq, chunkStartSec: pendingStartSec, sampleRate: TARGET_RATE, pcm: floatToPcm16Base64(samples), cursor });
      pending = pending.slice(take);
      pendingStartSec += take / TARGET_RATE;
      seq++;
      cursor = response.cursor;
      showCaptions(response);
      if (!live) {
        live = true;
        opts.onStatus('live', { sessionIndex: 0 });
      }
    } catch (error) {
      // Keep the chunk; the next tick retries it with the same seq.
      live = false;
      opts.onStatus('reconnecting', { sessionIndex: 0, error: error instanceof Error ? error.message : String(error) });
    } finally {
      inFlight = false;
    }
    // A round trip takes longer than the tick: send what piled up meanwhile right away instead of idling until it.
    if (!stopped && live && pending.length >= TARGET_RATE / 4) void pushOnce();
  };

  opts.onStatus('connecting', { sessionIndex: 0 });
  opts.onStarted(0, 0);
  const timer = setInterval(() => void pushOnce(), PUSH_INTERVAL_MS);

  return {
    async stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      // Send what is left so the last utterance is recognised.
      for (let attempt = 0; attempt < 3 && pending.length > 0; attempt++) {
        while (inFlight) await new Promise((resolve) => setTimeout(resolve, 50));
        await pushOnce();
      }
      processor.disconnect();
      source.disconnect();
      mute.disconnect();
      await context.close().catch(() => undefined);
      opts.onStatus('off', { sessionIndex: 0 });
    },
  };
}
