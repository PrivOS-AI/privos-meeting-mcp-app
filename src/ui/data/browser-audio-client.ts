/**
 * Live captions for a meeting recorded from the Room's shared browser
 * (PrivOS Remote Browser in a Google Meet call). The audio never passes
 * through this iframe — the app's server reads it from Remote Browser — so
 * there is nothing to push: this asks `meeting_browser_audio` (action `poll`)
 * about once a second for the captions since its cursor and the listener's
 * state, one request at a time.
 */
import { createCaptionEmitter, type AudioPushResponse } from './local-realtime-client.js';
import type { RealtimeConnection, RealtimeConnectionCallbacks } from './realtime-client.js';

const POLL_INTERVAL_MS = 800;

export type BrowserAudioState = 'connecting' | 'listening' | 'waiting' | 'stopped';
export type BrowserAudioProblem = 'no_browser' | 'no_audio' | 'busy' | 'unavailable' | 'unauthorized';

export interface BrowserAudioResponse extends AudioPushResponse {
  state: BrowserAudioState;
  problem?: BrowserAudioProblem;
  heardSec: number;
  partsUploaded: number;
}

export interface BrowserAudioConnectionOptions extends Pick<RealtimeConnectionCallbacks, 'onCaption' | 'onStatus' | 'onStarted'> {
  poll: (cursor: number) => Promise<BrowserAudioResponse>;
  /** The listener's state, for the "waiting for the Room browser" notice. */
  onBrowserState: (state: BrowserAudioState, problem: BrowserAudioProblem | undefined) => void;
}

export function createBrowserAudioConnection(opts: BrowserAudioConnectionOptions): RealtimeConnection {
  const showCaptions = createCaptionEmitter(opts.onCaption);
  let cursor = 0;
  let stopped = false;
  let inFlight = false;

  const pollOnce = async (): Promise<void> => {
    if (inFlight || stopped) return;
    inFlight = true;
    try {
      const response = await opts.poll(cursor);
      cursor = response.cursor;
      showCaptions(response);
      opts.onBrowserState(response.state, response.problem);
      opts.onStatus(response.state === 'listening' ? 'live' : 'reconnecting', { sessionIndex: 0, ...(response.problem ? { error: response.problem } : {}) });
    } catch (error) {
      opts.onStatus('reconnecting', { sessionIndex: 0, error: error instanceof Error ? error.message : String(error) });
    } finally {
      inFlight = false;
    }
  };

  opts.onStatus('connecting', { sessionIndex: 0 });
  opts.onStarted(0, 0);
  const timer = setInterval(() => void pollOnce(), POLL_INTERVAL_MS);

  return {
    async stop() {
      if (stopped) return;
      while (inFlight) await new Promise((resolve) => setTimeout(resolve, 50));
      // One last read so the final utterance shows before the screen moves on.
      await pollOnce();
      stopped = true;
      clearInterval(timer);
      opts.onStatus('off', { sessionIndex: 0 });
    },
  };
}
