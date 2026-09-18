/**
 * Hub AI translation path (QĐ-12b) — used only when `!capabilities.translation`
 * (ElevenLabs, or Soniox when native two-way translation turns out to conflict
 * with diarization). Batches finalized caption lines every 3-5s and calls
 * `meeting_translate`; a failed/timed-out batch is dropped, never retried and
 * never blocking caption rendering (spec).
 */
import { parseToolResult } from '@privos_ai/app-react';
import type { McpApp } from '@privos_ai/app-react';

export interface TranslateBufferLine {
  id: string;
  text: string;
  lang?: string;
}

export interface TranslateBufferOptions {
  roomId: string;
  meetingId: string;
  target: 'vi' | 'en';
  /** 3-5s per spec; injectable for tests. */
  flushIntervalMs?: number;
  onTranslated(translations: Array<{ id: string; text: string }>): void;
  onError?(error: unknown): void;
}

interface TranslateToolResponse {
  translations?: Array<{ id: string; text: string }>;
}

const DEFAULT_FLUSH_INTERVAL_MS = 4000;

export class TranslateBuffer {
  private pending: TranslateBufferLine[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private enabled = true;

  constructor(
    private readonly app: McpApp,
    private readonly opts: TranslateBufferOptions,
  ) {
    this.timer = setInterval(() => void this.flush(), opts.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS);
  }

  /** Only bring in a finalized line already in a DIFFERENT language than the target — see QĐ-12. */
  push(line: TranslateBufferLine): void {
    if (!this.enabled) return;
    if (line.lang && line.lang === this.opts.target) return;
    this.pending.push(line);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.pending = [];
  }

  async flush(): Promise<void> {
    if (this.pending.length === 0) return;
    const batch = this.pending;
    this.pending = [];
    try {
      const raw = await this.app.callServerTool({
        name: 'meeting_translate',
        arguments: { roomId: this.opts.roomId, meetingId: this.opts.meetingId, target: this.opts.target, segments: batch },
      });
      const parsed = parseToolResult(raw) as TranslateToolResponse;
      this.opts.onTranslated(parsed?.translations ?? []);
    } catch (error) {
      // A dropped batch only delays translation for those lines — never blocks captions.
      this.opts.onError?.(error);
    }
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.pending = [];
  }
}
