/**
 * The meeting clock IS the recorder's clock (QĐ-17). `recorderEpochMs` is
 * captured once, right before `MediaRecorder.start()`; every realtime
 * session's tokens are converted onto that single timeline via the offset
 * captured at the SDK's "stream actually started" callback — never at mint
 * time or socket-open time, both of which race ahead of when the SDK starts
 * consuming real audio (it buffers while the key round-trips).
 */
import type { LiveTurn } from './realtime-client.js';

export interface SessionMeta {
  index: number;
  wsSessionOffsetMs: number;
  startedAt: string;
  clockSkewMs: number;
}

/** Persisted onto `meetings.sttSessionMeta` — P3 reconciles the async pass against this. */
export interface SttSessionMeta {
  recorderEpochMs: number;
  sessions: SessionMeta[];
}

/** A part's time window on the meeting clock, in milliseconds. */
export interface PartWindow {
  seq: number;
  startMs: number;
  endMs: number;
}

/** |skew| beyond this is no longer "close enough" — the part gets flagged `approxClock` for the backend. */
const SKEW_TOLERANCE_MS = 1500;

export class MeetingClock {
  private readonly sessions = new Map<number, SessionMeta>();
  /** Turns already sent to the backend in their final form — never resent (S2-03). */
  private readonly sentFinalTurnIds = new Set<string>();
  private lastPartBoundaryMs = 0;

  constructor(public readonly recorderEpochMs: number) {}

  /** Elapsed recorder time right now, in ms — the single authoritative "now" for this meeting. */
  elapsedMs(nowMs: number = performance.now()): number {
    return nowMs - this.recorderEpochMs;
  }

  /** Call from the realtime wrapper's "stream actually started" callback — never at mint or socket-open time. */
  registerSessionStart(sessionIndex: number, nowMs: number = performance.now()): number {
    const offsetMs = this.elapsedMs(nowMs);
    this.sessions.set(sessionIndex, {
      index: sessionIndex,
      wsSessionOffsetMs: offsetMs,
      startedAt: new Date().toISOString(),
      clockSkewMs: 0,
    });
    return offsetMs;
  }

  /** Raw session-relative token ms → meeting ms, applying the session's offset and last-measured skew. */
  toMeetingMs(sessionIndex: number, rawMs: number): number {
    const session = this.sessions.get(sessionIndex);
    const offset = session?.wsSessionOffsetMs ?? 0;
    const skew = session?.clockSkewMs ?? 0;
    return offset + rawMs + skew;
  }

  /**
   * Resync when a part closes: compare the recorder's own elapsed time against
   * where the last FINAL token of that session claims the audio ended. Beyond
   * tolerance, the part is `approxClock` — P5 skips embedding it rather than
   * risking a mis-cut voiceprint sample.
   */
  resyncOnPartClose(sessionIndex: number, elapsedRecorderMs: number, lastFinalEndMsRaw: number): { skewMs: number; approxClock: boolean } {
    const session = this.sessions.get(sessionIndex);
    const offset = session?.wsSessionOffsetMs ?? 0;
    const skewMs = elapsedRecorderMs - (offset + lastFinalEndMsRaw);
    if (session) session.clockSkewMs = skewMs;
    return { skewMs, approxClock: Math.abs(skewMs) > SKEW_TOLERANCE_MS };
  }

  /** Actual elapsed recorder time since the previous part boundary — what the backend uses to advance its own clock even if a chunk fails to process. */
  measuredPartMs(nowElapsedMs: number): number {
    const duration = nowElapsedMs - this.lastPartBoundaryMs;
    this.lastPartBoundaryMs = nowElapsedMs;
    return Math.max(0, Math.round(duration));
  }

  /** `{ recorderEpochMs, sessions[] }` for `meetings.sttSessionMeta`. */
  toSttSessionMeta(): SttSessionMeta {
    return {
      recorderEpochMs: this.recorderEpochMs,
      sessions: [...this.sessions.values()].sort((a, b) => a.index - b.index),
    };
  }

  /**
   * Turns to send for `meeting_chunk_ready` on part `window`: every turn that
   * STARTED inside this part's window, plus any earlier turn that was sent
   * not-yet-final and still has not been confirmed final (S2-03 — a turn
   * spanning a part boundary is resent, never truncated, until its final form
   * ships once). A turn's final form is marked sent only after this call
   * returns it with `final: true`.
   */
  turnsInPart(allTurns: readonly LiveTurn[], window: PartWindow): LiveTurn[] {
    const selected = allTurns.filter((turn) => {
      if (this.sentFinalTurnIds.has(turn.id)) return false;
      const startedInWindow = turn.startMs >= window.startMs && turn.startMs < window.endMs;
      const pendingFromEarlier = turn.startMs < window.startMs;
      return startedInWindow || pendingFromEarlier;
    });
    for (const turn of selected) {
      if (turn.final) this.sentFinalTurnIds.add(turn.id);
    }
    return selected;
  }
}
