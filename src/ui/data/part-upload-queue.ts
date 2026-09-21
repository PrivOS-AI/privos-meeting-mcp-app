/**
 * FIFO retry queue for part uploads (S2-11). `enqueue` returns immediately —
 * recording never waits on the network. A single worker retries the head of
 * the queue with exponential backoff capped at 30s, for up to
 * `LIVE_UPLOAD_RETRY_WINDOW_MIN` minutes per part; once a part's window
 * expires the worker stops (the part stays queued) until `retry()` is called
 * by hand (the "End & summarize" flow's retry button). A hard cap on queued
 * parts protects the flat-memory requirement over a long recording.
 */
export interface QueuedPart {
  seq: number;
  blob: Blob;
  /** Absolute part-boundary stamp (`performance.now() - recorderEpochMs`) this part starts at — see `media-recorder-service.ts`. */
  partStartMs: number;
  /** This part's wall span, measured at blob-emit time. */
  durationMs: number;
  attempts: number;
}

export interface PartUploadQueueOptions {
  /** Minutes to keep retrying automatically before giving up until a manual retry (`LIVE_UPLOAD_RETRY_WINDOW_MIN`). */
  retryWindowMin: number;
  /** Hard cap on parts held in RAM at once (~5MB opus at the default cap). */
  maxQueuedParts?: number;
  maxBackoffMs?: number;
  onPendingCountChange?(count: number): void;
  /** The queue is full — recording should stop with a warning rather than grow unbounded. */
  onCapReached?(seq: number): void;
  /** This part's retry window elapsed; it stays queued for a manual `retry()`. */
  onWindowExpired?(seq: number): void;
  /** Injectable clock/sleep for tests. */
  now?(): number;
  sleep?(ms: number): Promise<void>;
}

export type UploadFn = (part: { seq: number; blob: Blob; partStartMs: number; durationMs: number }) => Promise<void>;

const DEFAULT_MAX_BACKOFF_MS = 30_000;
const DEFAULT_MAX_QUEUED_PARTS = 20;

export class PartUploadQueue {
  private readonly queue: QueuedPart[] = [];
  private readonly firstAttemptAt = new Map<number, number>();
  private readonly maxBackoffMs: number;
  private readonly retryWindowMs: number;
  private readonly maxQueuedParts: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private running = false;

  constructor(
    private readonly upload: UploadFn,
    private readonly opts: PartUploadQueueOptions,
  ) {
    this.maxBackoffMs = opts.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.retryWindowMs = opts.retryWindowMin * 60_000;
    this.maxQueuedParts = opts.maxQueuedParts ?? DEFAULT_MAX_QUEUED_PARTS;
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  get pendingCount(): number {
    return this.queue.length;
  }

  get isFull(): boolean {
    return this.queue.length >= this.maxQueuedParts;
  }

  /** Queue one part for upload. Never blocks the caller (recording continues regardless of network state). */
  enqueue(seq: number, blob: Blob, partStartMs: number, durationMs: number): void {
    if (this.isFull) {
      this.opts.onCapReached?.(seq);
      return;
    }
    this.queue.push({ seq, blob, partStartMs, durationMs, attempts: 0 });
    this.opts.onPendingCountChange?.(this.queue.length);
    if (!this.running) void this.run();
  }

  /** Resume the worker by hand — used after a window expired, or right before "End & summarize". */
  retry(): void {
    if (!this.running && this.queue.length > 0) void this.run();
  }

  private async run(): Promise<void> {
    this.running = true;
    while (this.queue.length > 0) {
      const part = this.queue[0];
      if (!this.firstAttemptAt.has(part.seq)) this.firstAttemptAt.set(part.seq, this.now());

      try {
        await this.upload({ seq: part.seq, blob: part.blob, partStartMs: part.partStartMs, durationMs: part.durationMs });
        this.queue.shift();
        this.firstAttemptAt.delete(part.seq);
        this.opts.onPendingCountChange?.(this.queue.length);
        continue;
      } catch {
        part.attempts += 1;
        const elapsed = this.now() - (this.firstAttemptAt.get(part.seq) ?? this.now());
        if (elapsed >= this.retryWindowMs) {
          this.opts.onWindowExpired?.(part.seq);
          this.running = false;
          return;
        }
        const backoffMs = Math.min(this.maxBackoffMs, 1000 * 2 ** (part.attempts - 1));
        await this.sleep(backoffMs);
      }
    }
    this.running = false;
  }
}
