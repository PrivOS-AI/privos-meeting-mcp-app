import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `MediaRecorder`/`MediaStream` do not exist in the `node` vitest environment
 * (`vitest.config.ts`) — a minimal fake stands in. `pause`/`resume` are spies
 * so a regression that calls the REAL recorder API (forbidden — pause is mute
 * only, see the module's class docs) fails loudly instead of silently.
 */
class FakeAudioTrack {
  enabled = true;
}

class FakeMediaStream {
  private readonly tracks: FakeAudioTrack[];
  constructor(trackCount = 1) {
    this.tracks = Array.from({ length: trackCount }, () => new FakeAudioTrack());
  }
  getAudioTracks(): FakeAudioTrack[] {
    return this.tracks;
  }
}

let lastCreatedRecorder: FakeMediaRecorder | null = null;

class FakeMediaRecorder {
  static isTypeSupported(): boolean {
    return true;
  }
  ondataavailable: ((event: { data: { size: number } }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onstop: (() => void) | null = null;
  pause = vi.fn();
  resume = vi.fn();
  stop = vi.fn(() => this.onstop?.());

  constructor(
    public readonly stream: FakeMediaStream,
    public readonly options: { mimeType: string },
  ) {
    lastCreatedRecorder = this;
  }

  start(_timesliceMs: number): void {
    // no-op — tests drive `ondataavailable` directly.
  }

  /** Test helper: simulate the browser firing one part. */
  emitPart(size = 10): void {
    this.ondataavailable?.({ data: { size } });
  }
}

(globalThis as unknown as { MediaRecorder: unknown }).MediaRecorder = FakeMediaRecorder;

const { MediaRecorderService } = await import('./media-recorder-service.js');

let nowMs = 0;

beforeEach(() => {
  nowMs = 0;
  lastCreatedRecorder = null;
  vi.spyOn(performance, 'now').mockImplementation(() => nowMs);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MediaRecorderService', () => {
  it('stamps each part with the PREVIOUS boundary as partStartMs (0 for part 0) and this span as durationMs', () => {
    const stream = new FakeMediaStream() as unknown as MediaStream;
    const parts: { seq: number; partStartMs: number; durationMs: number }[] = [];
    const service = new MediaRecorderService(stream, 1_000, (p) => parts.push(p), () => {});
    service.start();
    const recorder = lastCreatedRecorder!;

    nowMs = 1_000; // elapsed 0
    recorder.emitPart();
    nowMs = 1_000 + 60_000; // elapsed 60_000
    recorder.emitPart();
    nowMs = 1_000 + 60_000 + 61_500; // elapsed 121_500 (a slightly long part — e.g. a slow tab)
    recorder.emitPart();

    expect(parts).toEqual([
      { seq: 0, blob: { size: 10 }, partStartMs: 0, durationMs: 0 },
      { seq: 1, blob: { size: 10 }, partStartMs: 0, durationMs: 60_000 },
      { seq: 2, blob: { size: 10 }, partStartMs: 60_000, durationMs: 61_500 },
    ]);
  });

  it('drops a zero-size blob without emitting a part or advancing seq', () => {
    const stream = new FakeMediaStream() as unknown as MediaStream;
    const parts: unknown[] = [];
    const service = new MediaRecorderService(stream, 0, (p) => parts.push(p), () => {});
    service.start();
    lastCreatedRecorder!.emitPart(0);
    expect(parts).toEqual([]);
  });

  it('never calls the browser MediaRecorder.pause()/resume() — pause is mute only', () => {
    const stream = new FakeMediaStream() as unknown as MediaStream;
    const service = new MediaRecorderService(stream, 0, () => {}, () => {});
    service.start();
    const recorder = lastCreatedRecorder!;

    service.pause();
    service.resume();

    expect(recorder.pause).not.toHaveBeenCalled();
    expect(recorder.resume).not.toHaveBeenCalled();
  });

  it('(f) mute -> pause -> resume stays muted; resume never unconditionally re-enables the track', () => {
    const stream = new FakeMediaStream();
    const service = new MediaRecorderService(stream as unknown as MediaStream, 0, () => {}, () => {});
    service.start();
    const track = stream.getAudioTracks()[0];

    service.setMuted(true);
    expect(track.enabled).toBe(false);

    service.pause();
    expect(track.enabled).toBe(false);

    service.resume();
    expect(track.enabled).toBe(false); // still muted — resume must not un-mute

    service.setMuted(false); // only the user's own unmute re-enables the track
    expect(track.enabled).toBe(true);
  });

  it('pause disables the track even when NOT muted, and resume restores it', () => {
    const stream = new FakeMediaStream();
    const service = new MediaRecorderService(stream as unknown as MediaStream, 0, () => {}, () => {});
    service.start();
    const track = stream.getAudioTracks()[0];

    service.pause();
    expect(track.enabled).toBe(false);

    service.resume();
    expect(track.enabled).toBe(true);
  });

  it('muting while paused, then resuming, restores the JUST-SET mute state', () => {
    const stream = new FakeMediaStream();
    const service = new MediaRecorderService(stream as unknown as MediaStream, 0, () => {}, () => {});
    service.start();
    const track = stream.getAudioTracks()[0];

    service.pause();
    service.setMuted(true); // muted while paused
    expect(track.enabled).toBe(false);

    service.resume();
    expect(track.enabled).toBe(false); // resume respects the mute set during the pause
  });
});
