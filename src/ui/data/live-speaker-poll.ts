/**
 * Polls `meeting_live_speakers` every 4s while recording (provider has
 * speaker labels only — D-18). Exposes the raw session-speaker list AND the
 * settled TURNS the server decided on (`turns`), each already carrying its
 * own final `sessionSpeakerId` — this module no longer collapses turns onto
 * the realtime label itself (`recording-store.ts` does the per-line
 * resolution, reading `turns` directly). `sinceMs` is a monotonic cursor:
 * after the first response with a real `nextSinceMs`, this poll only asks for
 * turns newer than what it has already seen.
 */
import { parseToolResult } from '@privos_ai/app-react';
import type { McpApp } from '@privos_ai/app-react';

export interface LiveSpeaker {
  sessionSpeakerId: string;
  sonioxLabels: string[];
  displayName?: string;
  profileId?: string;
  liveConfidence?: number;
  liveSpeechSec: number;
  colorKey: string;
  resolved: boolean;
  /** Set when this session speaker lost a merge — its labels are already folded into the winner's own `sonioxLabels`, so callers should treat this entry as a historical alias, not a live speaker of its own. */
  mergedInto?: string;
}

/** One settled turn — the server's own per-turn identity decision. `label` is the realtime label (base form, or `label@n` for a just-recycled instance) this turn was embedded under; `sessionSpeakerId` is who the server decided it belongs to (already remapped through any merge). */
export interface ServerTurn {
  startMs: number;
  endMs: number;
  label: string;
  sessionSpeakerId: string;
}

interface LiveSpeakersResponse {
  sessionSpeakers?: LiveSpeaker[];
  turns?: ServerTurn[];
  nextSinceMs?: number;
  degraded?: boolean;
  labelsSupported?: boolean;
  updatedAt?: string;
}

export interface LiveSpeakerPollOptions {
  roomId: string;
  meetingId: string;
  intervalMs?: number;
  /** Every poll's raw speakers + the settled turns newer than the last poll — drives both the "Who's speaking?" chip row and the per-line server-identity resolution. */
  onUpdate(speakers: LiveSpeaker[], turns: ServerTurn[], meta: { degraded: boolean; labelsSupported: boolean }): void;
}

const DEFAULT_INTERVAL_MS = 4000;

export class LiveSpeakerPoll {
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  /** `sinceMs` cursor — `undefined` until the server hands back a real one (`nextSinceMs >= 0`); a negative `nextSinceMs` means "no turns settled yet", so the next request still asks for the default recent window instead of an invalid negative cursor. */
  private sinceMs: number | undefined;

  constructor(
    private readonly app: McpApp,
    private readonly opts: LiveSpeakerPollOptions,
  ) {
    this.timer = setInterval(() => void this.pollOnce(), opts.intervalMs ?? DEFAULT_INTERVAL_MS);
  }

  async pollOnce(): Promise<void> {
    if (this.stopped) return;
    try {
      const raw = await this.app.callServerTool({
        name: 'meeting_live_speakers',
        arguments: { roomId: this.opts.roomId, meetingId: this.opts.meetingId, ...(this.sinceMs !== undefined ? { sinceMs: this.sinceMs } : {}) },
      });
      const parsed = parseToolResult(raw) as LiveSpeakersResponse;
      if (typeof parsed?.nextSinceMs === 'number' && parsed.nextSinceMs >= 0) this.sinceMs = parsed.nextSinceMs;
      this.opts.onUpdate(parsed?.sessionSpeakers ?? [], parsed?.turns ?? [], {
        degraded: parsed?.degraded === true,
        labelsSupported: parsed?.labelsSupported !== false,
      });
    } catch {
      // Not available before Phase 5, or a transient failure — badges just stay unresolved longer.
    }
  }

  /** Stop polling — call when the meeting leaves `recording` (spec: never polls outside that state). */
  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
