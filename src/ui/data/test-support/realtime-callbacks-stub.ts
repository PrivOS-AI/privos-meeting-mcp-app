/**
 * Records every callback a `RealtimeConnectionOptions` consumer would receive,
 * so wrapper tests can assert on captions/turns/status without a real store.
 */
import type { CaptionEvent, CaptionStatus, LiveTurn, RealtimeConnectionCallbacks } from '../realtime-client.js';

export class RealtimeConnectionCallbacksStub {
  captions: CaptionEvent[] = [];
  turns: LiveTurn[][] = [];
  started: Array<[number, number]> = [];
  statuses: Array<[CaptionStatus, { sessionIndex: number; error?: string } | undefined]> = [];

  options(): RealtimeConnectionCallbacks {
    return {
      onCaption: (event) => this.captions.push(event),
      onTurns: (turns) => this.turns.push(turns),
      onStarted: (sessionIndex, offsetMs) => this.started.push([sessionIndex, offsetMs]),
      onStatus: (status, info) => this.statuses.push([status, info]),
    };
  }
}
