import { describe, expect, it, vi } from 'vitest';

import { KeyedSerialQueue } from './keyed-serial-queue.js';

function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('KeyedSerialQueue', () => {
  it('never runs two tasks of the same key concurrently', async () => {
    const queue = new KeyedSerialQueue<number>();
    const order: string[] = [];
    const gate = deferred();

    const p1 = queue.enqueue('meeting-1', 1, async () => {
      order.push('start-1');
      await gate.promise;
      order.push('end-1');
    });
    const p2 = queue.enqueue('meeting-1', 2, async () => {
      order.push('start-2');
      order.push('end-2');
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual(['start-1']);
    gate.resolve();
    await Promise.all([p1, p2]);
    expect(order).toEqual(['start-1', 'end-1', 'start-2', 'end-2']);
  });

  it('runs tasks of different keys in parallel', async () => {
    const queue = new KeyedSerialQueue<number>();
    const order: string[] = [];
    const gateA = deferred();

    const pA = queue.enqueue('meeting-a', 1, async () => {
      order.push('start-a');
      await gateA.promise;
      order.push('end-a');
    });
    const pB = queue.enqueue('meeting-b', 1, async () => {
      order.push('start-b');
      order.push('end-b');
    });

    await pB;
    expect(order).toEqual(['start-a', 'start-b', 'end-b']);
    gateA.resolve();
    await pA;
    expect(order).toContain('end-a');
  });

  it('drops the oldest queued task once backlog exceeds maxBacklog, and reports it', async () => {
    const dropped: number[] = [];
    const queue = new KeyedSerialQueue<number>({ maxBacklog: 3, onDropped: (_key, item) => dropped.push(item) });
    const gate = deferred();

    // First task starts running immediately (occupies the "running" slot, not backlog).
    const running = queue.enqueue('meeting-1', 0, async () => {
      await gate.promise;
    });
    // Next 5 all sit in backlog (cap 3) while task 0 is running.
    const results = [1, 2, 3, 4, 5].map((n) => queue.enqueue('meeting-1', n, async () => undefined));

    expect(dropped).toEqual([1, 2]); // oldest-first eviction once backlog > 3
    gate.resolve();
    await Promise.all([running, ...results]);
  });

  it('abort() waits for the running task to actually exit before resolving', async () => {
    const queue = new KeyedSerialQueue<number>();
    let cleanedUp = false;
    const started = deferred();

    const running = queue.enqueue('meeting-1', 1, async (_item, signal) => {
      started.resolve();
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => {
          setTimeout(() => {
            cleanedUp = true;
            resolve();
          }, 20);
        });
      });
    });

    await started.promise;
    await queue.abort('meeting-1');
    expect(cleanedUp).toBe(true);
    await running;
  });

  it('clears queued backlog on abort without running it', async () => {
    const queue = new KeyedSerialQueue<number>();
    const ran = vi.fn();
    const gate = deferred();

    // The running task must itself observe the abort signal to exit —
    // `abort()` only requests cancellation, it cannot force a task to stop.
    const running = queue.enqueue('meeting-1', 1, async (_item, signal) => {
      await new Promise<void>((resolve) => {
        gate.promise.then(resolve);
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
    });
    const queued = queue.enqueue('meeting-1', 2, async () => {
      ran();
    });

    await queue.abort('meeting-1');
    gate.resolve();
    await Promise.all([running, queued]);
    expect(ran).not.toHaveBeenCalled();
  });
});
