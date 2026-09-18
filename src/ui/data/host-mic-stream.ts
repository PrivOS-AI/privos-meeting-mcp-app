/**
 * Host-brokered microphone → `MediaStream` adapter.
 *
 * The app document runs in an opaque origin, where the browser refuses
 * `getUserMedia` even though the iframe delegates `microphone` (the grant is
 * present but `window.origin === "null"`, so Chrome will not attach a mic
 * permission to it). app-react's `app.startMicrophone` instead captures under
 * the HOST's own origin and streams mono PCM16 frames. This adapter plays those
 * frames through a WebAudio graph into a `MediaStreamAudioDestinationNode`,
 * reconstructing a live `MediaStream` so the existing MediaRecorder and realtime
 * STT SDK — both of which consume a `MediaStream` — keep working unchanged.
 *
 * AudioWorklets are unavailable here (`import.meta.url` is `about:srcdoc`, so
 * `addModule` cannot fetch a worklet file), so frames are scheduled as
 * back-to-back AudioBuffers on the context clock instead of through a worklet.
 */
import type { McpApp } from '@privos_ai/app-react';

export interface HostMicOptions {
  /** Preferred capture rate in Hz; the reconstructed track carries the rate the host actually grants. */
  sampleRate?: number;
  echoCancellation?: boolean;
  noiseSuppression?: boolean;
  autoGainControl?: boolean;
  /** Capture ended on its own (device unplugged, permission revoked) — never from our `stop()`. */
  onEnded?: (reason: string) => void;
}

export type HostMicResult =
  | { kind: 'stream'; stream: MediaStream; sampleRate: number; stop: () => void }
  /** Host predates brokered devices — caller should fall back to `navigator.mediaDevices.getUserMedia`. */
  | { kind: 'unsupported' }
  /** Host refused; `reason` is a `MicrophoneDenialReason` (not_declared | user_activation_required | denied | unavailable). */
  | { kind: 'denied'; reason: string };

/**
 * Start host-brokered capture and hand back a `MediaStream`. Must be called from
 * a user-gesture handler (the host enforces the same activation rule as
 * `getUserMedia`). Returns `{ kind: 'unsupported' }` when the host has no
 * `startMicrophone` so the caller can fall back to direct `getUserMedia`.
 */
export async function startHostMicStream(app: McpApp, options: HostMicOptions = {}): Promise<HostMicResult> {
  if (typeof app.startMicrophone !== 'function') return { kind: 'unsupported' };

  // The granted sample rate is only known after the grant resolves, but frames
  // can arrive before then — buffer early frames and flush once the audio graph
  // is built at the granted rate (mismatched rates would pitch-shift the audio).
  const pending: Int16Array[] = [];
  let schedule: (chunk: Int16Array) => void = (chunk) => pending.push(chunk);

  const result = await app.startMicrophone({
    sampleRate: options.sampleRate ?? 16000,
    echoCancellation: options.echoCancellation,
    noiseSuppression: options.noiseSuppression,
    autoGainControl: options.autoGainControl,
    onData: (chunk) => schedule(chunk),
    onEnded: options.onEnded,
  });

  if (!result.granted) return { kind: 'denied', reason: result.reason };

  const ctx = new AudioContext({ sampleRate: result.sampleRate });
  // A click gesture drives this call, so resume() is allowed; ignore the promise.
  void ctx.resume();
  const dest = ctx.createMediaStreamDestination();
  // Scheduling cursor on the context clock, kept a hair ahead of `currentTime`
  // so steadily-arriving frames play gaplessly; re-anchored after any underrun.
  let playHead = 0;

  schedule = (chunk: Int16Array) => {
    if (chunk.length === 0) return;
    const buffer = ctx.createBuffer(1, chunk.length, ctx.sampleRate);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < chunk.length; i++) channel[i] = chunk[i] / 0x8000;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(dest);
    const startAt = Math.max(ctx.currentTime, playHead);
    source.start(startAt);
    playHead = startAt + buffer.duration;
  };
  for (const chunk of pending) schedule(chunk);
  pending.length = 0;

  const stop = (): void => {
    try {
      result.stop();
    } catch {
      // Host frame may already be gone — closing the context below is enough.
    }
    void ctx.close();
  };

  return { kind: 'stream', stream: dest.stream, sampleRate: result.sampleRate, stop };
}
