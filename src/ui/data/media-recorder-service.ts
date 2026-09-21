/**
 * The storage-branch `MediaRecorder` wrapper (D-13). Records the SAME
 * `MediaStream` the realtime SDK also consumes, in ~60s timeslices; each blob
 * is handed to the caller and then dropped immediately — the meeting is never
 * held whole in RAM (non-functional requirement: flat memory over 60 minutes).
 *
 * Pause = mute only: `MediaRecorder.pause()/resume()` are NEVER called. Pausing
 * makes the recorded audio shorter than wall time, which both mis-slices the
 * part containing the pause and permanently shifts the concatenated audio
 * against the wall-anchored live turns (breaking the post-meeting async→live
 * mapping). Instead, pause disables the mic track (`track.enabled = false`,
 * the same technique ElevenLabs' own `RealtimeConnection.mute()` uses) so the
 * browser emits silence frames on that same live track while the recorder
 * keeps running — both the recorder and the realtime SDK stay on one
 * continuous timeline; a paused span is stored as silence, not a gap.
 *
 * Mute and pause both want the SAME track disabled, so this class is the
 * single owner of `track.enabled` and combines the two independent flags
 * itself (`enabled = !muted && !paused`) — `resume()` restores the track to
 * whatever the user's own mute toggle currently says, never unconditionally
 * back on.
 */
export const PART_MS = 60_000;

export type MediaRecorderPhase = 'idle' | 'recording' | 'paused' | 'stopped';

export interface RecorderPart {
  seq: number;
  blob: Blob;
  /**
   * Absolute part-boundary stamp for the START of this part —
   * `performance.now() - recorderEpochMs` captured for the PREVIOUS boundary
   * inside `ondataavailable` (0 for part 0). Same wall clock as turn
   * timestamps (`soniox-realtime-client.ts`), so the server can slice this
   * part's audio without ever summing durations itself.
   */
  partStartMs: number;
  /** This part's wall span: this boundary's stamp minus the previous one, measured at blob-emit time — never after the upload completes. */
  durationMs: number;
}

/** `audio/webm;codecs=opus` when supported, else a plain webm fallback (still opus on Chromium). */
export function pickMimeType(): string {
  const preferred = 'audio/webm;codecs=opus';
  if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported?.(preferred)) return preferred;
  return 'audio/webm';
}

export class MediaRecorderService {
  private recorder: MediaRecorder | null = null;
  private seq = 0;
  private phase: MediaRecorderPhase = 'idle';
  /** Previous part-boundary stamp on the `recorderEpochMs` clock — 0 until the first part is emitted. */
  private lastBoundaryMs = 0;
  private muted = false;
  private paused = false;

  constructor(
    private readonly stream: MediaStream,
    private readonly recorderEpochMs: number,
    private readonly onPart: (part: RecorderPart) => void,
    private readonly onError: (error: Error) => void,
  ) {}

  get currentPhase(): MediaRecorderPhase {
    return this.phase;
  }

  /** `enabled = !muted && !paused` — the one place this class writes `track.enabled`. */
  private applyTrackState(): void {
    const enabled = !this.muted && !this.paused;
    for (const track of this.stream.getAudioTracks()) track.enabled = enabled;
  }

  start(): void {
    if (this.recorder) throw new Error('MediaRecorderService.start called twice.');
    const mimeType = pickMimeType();
    const recorder = new MediaRecorder(this.stream, { mimeType });
    recorder.ondataavailable = (event: BlobEvent) => {
      if (event.data.size === 0) return;
      const boundaryMs = performance.now() - this.recorderEpochMs;
      const partStartMs = this.lastBoundaryMs;
      const durationMs = Math.max(0, Math.round(boundaryMs - this.lastBoundaryMs));
      this.lastBoundaryMs = boundaryMs;
      const part: RecorderPart = { seq: this.seq++, blob: event.data, partStartMs, durationMs };
      // Handed off to the caller (the upload queue) and never referenced
      // again here — the blob is free to be garbage-collected once uploaded.
      this.onPart(part);
    };
    recorder.onerror = (event: Event) => {
      const message = (event as { error?: DOMException }).error?.message ?? 'MediaRecorder error';
      this.onError(new Error(message));
    };
    recorder.start(PART_MS);
    this.recorder = recorder;
    this.phase = 'recording';
  }

  /** Mute/unmute the mic track directly — independent of pause, combined via `applyTrackState`. */
  setMuted(muted: boolean): void {
    this.muted = muted;
    this.applyTrackState();
  }

  /** Pause = mute only (see class docs). The recorder itself keeps running. */
  pause(): void {
    if (!this.recorder || this.phase !== 'recording') return;
    this.paused = true;
    this.applyTrackState();
    this.phase = 'paused';
  }

  /** Restores the track to the user's CURRENT mute state — never unconditionally re-enables it. */
  resume(): void {
    if (!this.recorder || this.phase !== 'paused') return;
    this.paused = false;
    this.applyTrackState();
    this.phase = 'recording';
  }

  /** Flushes the final (possibly short) part, then stops. Resolves once `onstop` fires. */
  stop(): Promise<void> {
    const recorder = this.recorder;
    if (!recorder || this.phase === 'stopped') return Promise.resolve();
    return new Promise((resolve) => {
      recorder.onstop = () => {
        this.phase = 'stopped';
        resolve();
      };
      recorder.stop();
    });
  }
}
