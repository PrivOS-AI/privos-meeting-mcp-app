/**
 * Polls `meeting_live_speakers` every 3-5s while recording (provider has
 * speaker labels only — D-18) and applies the returned map onto every
 * already-rendered caption line by `speakerKey`: relabel the badge, NEVER the
 * text (plan.md § "Relabel protocol"). Also exposes the raw session-speaker
 * list (`onSpeakersUpdate`) for the "Who's speaking?" chip row, and the
 * `degraded`/`labelsSupported` flags for the UI's own notices.
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

interface LiveSpeakersResponse {
  sessionSpeakers?: LiveSpeaker[];
  degraded?: boolean;
  labelsSupported?: boolean;
  updatedAt?: string;
}

export interface LiveSpeakerPollOptions {
  roomId: string;
  meetingId: string;
  intervalMs?: number;
  /** speakerKey -> LiveSpeaker, applied to every rendered line with that key. */
  onUpdate(map: Map<string, LiveSpeaker>): void;
  /** The raw list every poll — drives the "Who's speaking?" chip row. */
  onSpeakersUpdate?(speakers: LiveSpeaker[], meta: { degraded: boolean; labelsSupported: boolean }): void;
}

const DEFAULT_INTERVAL_MS = 4000;

/**
 * `speakerKey` is `s{sessionIndex}:{label}` — a `sonioxLabels` entry may carry
 * a `@n` split-instance suffix the badge ignores. A session speaker that lost
 * a merge (`mergedInto` set) is skipped here: the WINNER's own `sonioxLabels`
 * already includes every label the loser ever owned (see
 * `session-speaker-registry.ts`'s `maybeMerge`), so mapping the loser too
 * would non-deterministically overwrite the winner's entry depending on
 * array order.
 */
function toSpeakerKeyMap(speakers: LiveSpeaker[]): Map<string, LiveSpeaker> {
  const map = new Map<string, LiveSpeaker>();
  for (const speaker of speakers) {
    if (speaker.mergedInto) continue;
    for (const label of speaker.sonioxLabels) map.set(label.split('@')[0], speaker);
  }
  return map;
}

export class LiveSpeakerPoll {
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

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
        arguments: { roomId: this.opts.roomId, meetingId: this.opts.meetingId },
      });
      const parsed = parseToolResult(raw) as LiveSpeakersResponse;
      const speakers = parsed?.sessionSpeakers ?? [];
      this.opts.onUpdate(toSpeakerKeyMap(speakers));
      this.opts.onSpeakersUpdate?.(speakers, { degraded: parsed?.degraded === true, labelsSupported: parsed?.labelsSupported !== false });
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
