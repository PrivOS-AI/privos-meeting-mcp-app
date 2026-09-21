/**
 * The storage-branch `MediaRecorder` wrapper (D-13). Records the SAME
 * `MediaStream` the realtime SDK also consumes, in ~60s timeslices; each blob
 * is handed to the caller and then dropped immediately — the meeting is never
 * held whole in RAM (non-functional requirement: flat memory over 60 minutes).
 *
 * Pause/resume never stops or closes the track: `track.enabled = false` makes
 * the browser emit silence frames on that same live track (the same technique
 * ElevenLabs' own `RealtimeConnection.mute()` uses) instead of a gap that
 * would permanently skew the realtime SDK's `start_ms` against the recorder
 * clock.
 */
export const PART_MS = 60_000;

export type MediaRecorderPhase = 'idle' | 'recording' | 'paused' | 'stopped';

export interface RecorderPart {
  seq: number;
  blob: Blob;
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

  constructor(
    private readonly stream: MediaStream,
    private readonly onPart: (part: RecorderPart) => void,
    private readonly onError: (error: Error) => void,
  ) {}

  get currentPhase(): MediaRecorderPhase {
    return this.phase;
  }

  start(): void {
    if (this.recorder) throw new Error('MediaRecorderService.start called twice.');
    const mimeType = pickMimeType();
    const recorder = new MediaRecorder(this.stream, { mimeType });
    recorder.ondataavailable = (event: BlobEvent) => {
      if (event.data.size === 0) return;
      const part: RecorderPart = { seq: this.seq++, blob: event.data };
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

  /**
   * Pause the recorder but keep the realtime SDK fed with silence: the mic
   * track's `enabled` flag is flipped off, which makes the browser emit
   * silence frames on that track instead of closing it — both the recorder
   * and the realtime SDK keep consuming the SAME (now silent) stream.
   */
  pause(): void {
    if (!this.recorder || this.phase !== 'recording') return;
    for (const track of this.stream.getAudioTracks()) track.enabled = false;
    this.recorder.pause();
    this.phase = 'paused';
  }

  resume(): void {
    if (!this.recorder || this.phase !== 'paused') return;
    for (const track of this.stream.getAudioTracks()) track.enabled = true;
    this.recorder.resume();
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
