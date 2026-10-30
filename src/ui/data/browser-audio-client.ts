/**
 * Live captions for a meeting recorded from the Room's shared browser
 * (PrivOS Remote Browser in a Google Meet call). The audio never passes
 * through this iframe — the app's server reads it from Remote Browser — so
 * there is nothing to push: `meeting_captions_wait` requests held open
 * answer the moment a caption or a new draft is decoded, and the listener's
 * state (`meeting_browser_audio` poll) is asked every few seconds for the
 * "waiting for the Room browser" notice.
 */
import { createCaptionEmitter, createLatencyMeter, runCaptionWaits, withTimeout, type AudioPushResponse, type CaptionsWaitRequest } from './local-realtime-client.js';
import type { RealtimeConnection, RealtimeConnectionCallbacks } from './realtime-client.js';

const STATUS_EVERY_MS = 3_000;

export type BrowserAudioState = 'connecting' | 'listening' | 'waiting' | 'stopped';
export type BrowserAudioProblem = 'no_browser' | 'no_audio' | 'busy' | 'unavailable' | 'unauthorized';

export interface BrowserAudioResponse extends AudioPushResponse {
  state: BrowserAudioState;
  problem?: BrowserAudioProblem;
  heardSec: number;
  partsUploaded: number;
}

export interface BrowserAudioConnectionOptions extends Pick<RealtimeConnectionCallbacks, 'onCaption' | 'onStatus' | 'onStarted'> {
  recorderEpochMs: number;
  /** The listener's state (`meeting_browser_audio` poll). */
  poll: (cursor: number) => Promise<BrowserAudioResponse>;
  waitCaptions: (request: CaptionsWaitRequest) => Promise<AudioPushResponse>;
  /** The listener's state, for the "waiting for the Room browser" notice. */
  onBrowserState: (state: BrowserAudioState, problem: BrowserAudioProblem | undefined) => void;
}

export function createBrowserAudioConnection(opts: BrowserAudioConnectionOptions): RealtimeConnection {
  const showCaptions = createCaptionEmitter(opts.onCaption);
  const measure = createLatencyMeter(opts.recorderEpochMs, 'room browser');
  let cursor = 0;
  let draftRev = 0;
  let closed = false;
  const onCaptions = (response: AudioPushResponse) => {
    if (response.cursor < cursor) return;
    cursor = response.cursor;
    if (typeof response.draftRev === 'number') draftRev = response.draftRev;
    showCaptions(response);
    measure(response);
  };

  const pollStatus = async (): Promise<void> => {
    try {
      const response = await opts.poll(cursor);
      opts.onBrowserState(response.state, response.problem);
      opts.onStatus(response.state === 'listening' ? 'live' : 'reconnecting', { sessionIndex: 0, ...(response.problem ? { error: response.problem } : {}) });
    } catch (error) {
      opts.onStatus('reconnecting', { sessionIndex: 0, error: error instanceof Error ? error.message : String(error) });
    }
  };


  opts.onStatus('connecting', { sessionIndex: 0 });
  opts.onStarted(0, 0);
  void pollStatus();
  const timer = setInterval(() => void pollStatus(), STATUS_EVERY_MS);
  runCaptionWaits(opts.waitCaptions, () => ({ cursor, draftRev }), onCaptions, () => closed);

  return {
    async stop() {
      if (closed) return;
      clearInterval(timer);
      // One last read so the final utterance shows before the screen moves on.
      await withTimeout(opts.waitCaptions({ cursor, draftRev, waitMs: 1_500 }).then(onCaptions), 2_500).catch(() => undefined);
      closed = true;
      opts.onStatus('off', { sessionIndex: 0 });
    },
  };
}
