/**
 * A small, purpose-built queue for P5's chunk worker — NOT `render-queue.ts`
 * (genealogy's `RenderQueue`, `render-queue.ts:25-41`). That queue is a global
 * FIFO for one shared resource (Chromium render slots): it has no per-key
 * ordering and its timeout only rejects the outer promise, it never stops the
 * work itself — two chunks of the SAME meeting could run concurrently and
 * corrupt `session-speaker-registry.ts`'s in-memory state.
 *
 * This queue instead: serializes tasks PER KEY (`meetingId`) while running
 * different keys fully in parallel; caps the per-key backlog at `maxBacklog`
 * (default 3, "latest + 2") — a key that falls behind drops its OLDEST
 * still-queued task (never the one already running) and reports it via
 * `onDropped` so the caller can still advance that meeting's clock and flag
 * `degraded`; and gives every running task an `AbortController` it can
 * cooperatively check between steps, with `abort(key)` awaiting the actual
 * child task's exit before resolving — not just rejecting a promise.
 */

export type KeyedTask<T> = (item: T, signal: AbortSignal) => Promise<void>;

export interface KeyedSerialQueueOptions<T> {
  /** Per-key backlog cap (tasks queued but not yet running). Default 3. */
  maxBacklog?: number;
  /** Called for every task evicted from a full backlog, before it ever ran. */
  onDropped?: (key: string, item: T) => void;
}

interface Entry<T> {
  item: T;
  task: KeyedTask<T>;
  resolve: () => void;
}

interface KeyState<T> {
  running: boolean;
  controller: AbortController | null;
  runningPromise: Promise<void> | null;
  backlog: Entry<T>[];
}

const DEFAULT_MAX_BACKLOG = 3;

export class KeyedSerialQueue<T> {
  private readonly states = new Map<string, KeyState<T>>();
  private readonly maxBacklog: number;
  private readonly onDropped?: (key: string, item: T) => void;

  constructor(options: KeyedSerialQueueOptions<T> = {}) {
    this.maxBacklog = options.maxBacklog ?? DEFAULT_MAX_BACKLOG;
    this.onDropped = options.onDropped;
  }

  private stateFor(key: string): KeyState<T> {
    let state = this.states.get(key);
    if (!state) {
      state = { running: false, controller: null, runningPromise: null, backlog: [] };
      this.states.set(key, state);
    }
    return state;
  }

  /**
   * Queues one task under `key`. Resolves once the task has actually run (or
   * been dropped/aborted) — production callers fire-and-forget this
   * (`void queue.enqueue(...)`); tests await it to know when processing
   * finished. Never throws: a task's own error is swallowed here (the caller
   * is expected to handle its own errors internally, same contract as
   * `chunk-worker.ts`'s `finally`-based clock advance).
   */
  enqueue(key: string, item: T, task: KeyedTask<T>): Promise<void> {
    const state = this.stateFor(key);
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    state.backlog.push({ item, task, resolve: resolveDone });
    while (state.backlog.length > this.maxBacklog) {
      const dropped = state.backlog.shift();
      if (!dropped) break;
      this.onDropped?.(key, dropped.item);
      dropped.resolve();
    }
    this.pump(key, state);
    return done;
  }

  private pump(key: string, state: KeyState<T>): void {
    if (state.running) return;
    const next = state.backlog.shift();
    if (!next) return;

    state.running = true;
    const controller = new AbortController();
    state.controller = controller;
    state.runningPromise = next
      .task(next.item, controller.signal)
      .catch(() => undefined)
      .finally(() => {
        next.resolve();
        state.running = false;
        state.controller = null;
        state.runningPromise = null;
        this.pump(key, state);
      });
  }

  /** True while `key` has a task actively running (queued-but-not-started does not count). */
  isRunning(key: string): boolean {
    return this.states.get(key)?.running ?? false;
  }

  /** Number of tasks queued for `key` but not yet running. */
  backlogLength(key: string): number {
    return this.states.get(key)?.backlog.length ?? 0;
  }

  /**
   * Aborts the currently running task for `key` (a no-op if nothing is
   * running) and drops its queued backlog, THEN waits for the running task to
   * actually exit before resolving — the whole point of owning our own queue
   * instead of `render-queue.ts`, whose timeout only rejects a promise
   * without stopping the underlying work.
   */
  async abort(key: string): Promise<void> {
    const state = this.states.get(key);
    if (!state) return;
    for (const entry of state.backlog) entry.resolve();
    state.backlog = [];
    state.controller?.abort();
    if (state.runningPromise) await state.runningPromise;
  }
}
