/**
 * Adapted from `~/projects/genealogy-privos-mcp-app/src/server/export/render-queue.ts`'s
 * `RenderQueue` (same FIFO-slot shape) with two additions this phase needs:
 * an `AbortController` PER JOB so a timeout actually stops the work (kills
 * the ffmpeg child, aborts every fetch the task cooperates with) instead of
 * only rejecting the outer promise; and dedup by `meetingId` — a second
 * `enqueue` for a meeting already in flight returns the SAME promise rather
 * than starting a duplicate run.
 */
import { AppError } from '../../shared/app-error.js';
import { env } from '../env.js';

export type MeetingJobTask = (signal: AbortSignal) => Promise<void>;

interface RunningJob {
  promise: Promise<void>;
}

export class MeetingQueue {
  private readonly running = new Map<string, RunningJob>();
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly concurrency: number = 1) {}

  /** True while `meetingId` has a task queued for a slot or actively running. */
  isRunning(meetingId: string): boolean {
    return this.running.has(meetingId);
  }

  /** Enqueue one task for `meetingId`. A second call while the first is in flight returns the FIRST call's promise. */
  enqueue(meetingId: string, task: MeetingJobTask, timeoutMs: number): Promise<void> {
    const existing = this.running.get(meetingId);
    if (existing) return existing.promise;

    const controller = new AbortController();
    const promise = this.runTask(meetingId, task, controller, timeoutMs);
    this.running.set(meetingId, { promise });
    return promise;
  }

  private async acquireSlot(): Promise<void> {
    if (this.active < this.concurrency) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active++;
  }

  private releaseSlot(): void {
    this.active--;
    const next = this.waiters.shift();
    if (next) next();
  }

  private async runTask(meetingId: string, task: MeetingJobTask, controller: AbortController, timeoutMs: number): Promise<void> {
    await this.acquireSlot();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      await task(controller.signal);
    } catch (error) {
      throw error instanceof Error ? error : new AppError(String(error));
    } finally {
      clearTimeout(timer);
      this.releaseSlot();
      this.running.delete(meetingId);
    }
  }
}

/** One process-wide queue. `MEETING_JOB_CONCURRENCY` (default 1) caps parallel jobs. */
export const meetingQueue = new MeetingQueue(env.meetingJobConcurrency);

/** Re-exported so tool/job modules share one constant instead of reading `env` again. */
export const JOB_TIMEOUT_MS = env.meetingJobTimeoutMs;
