/**
 * Polls `meeting_live_speakers` every 3-5s while recording (provider has
 * speaker labels only — QĐ-18) and applies the returned map onto every
 * already-rendered caption line by `speakerKey`: relabel the badge, NEVER the
 * text. The backend tool itself lands in Phase 5; until then this simply gets
 * "unknown tool" errors, which are swallowed the same way a real miss would be
 * (the label just stays as "Người nói N" longer).
 */
import { parseToolResult } from '@privos_ai/app-react';
import type { McpApp } from '@privos_ai/app-react';

export interface LiveSpeaker {
  sessionSpeakerId: string;
  sonioxLabels: string[];
  displayName?: string;
  profileId?: string;
  liveConfidence?: number;
  colorKey: string;
  resolved: boolean;
}

interface LiveSpeakersResponse {
  sessionSpeakers?: LiveSpeaker[];
  updatedAt?: string;
}

export interface LiveSpeakerPollOptions {
  roomId: string;
  meetingId: string;
  intervalMs?: number;
  /** speakerKey -> LiveSpeaker, applied to every rendered line with that key. */
  onUpdate(map: Map<string, LiveSpeaker>): void;
}

const DEFAULT_INTERVAL_MS = 4000;

/** speakerKey is `s{sessionIndex}:{label}` — a `sonioxLabels` entry may carry a `@n` split suffix the badge ignores. */
function toSpeakerKeyMap(speakers: LiveSpeaker[]): Map<string, LiveSpeaker> {
  const map = new Map<string, LiveSpeaker>();
  for (const speaker of speakers) {
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
      this.opts.onUpdate(toSpeakerKeyMap(parsed?.sessionSpeakers ?? []));
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
