import { describe, expect, it, vi } from 'vitest';

import { PartUploadQueue } from './part-upload-queue.js';

function blob(): Blob {
  return new Blob(['x']);
}

describe('PartUploadQueue', () => {
  it('enqueue returns immediately and uploads succeed in seq order', async () => {
    const uploaded: number[] = [];
    const queue = new PartUploadQueue(
      async (part) => {
        uploaded.push(part.seq);
      },
      { retryWindowMin: 15 },
    );

    queue.enqueue(0, blob());
    queue.enqueue(1, blob());
    queue.enqueue(2, blob());

    await vi.waitFor(() => expect(queue.pendingCount).toBe(0));
    expect(uploaded).toEqual([0, 1, 2]);
  });

  it('keeps recording (never throws from enqueue) through 10 minutes of network failure, then drains in order once it recovers', async () => {
    let now = 0;
    const failUntilMs = 10 * 60_000;
    const uploaded: number[] = [];
    const sleeps: number[] = [];

    const queue = new PartUploadQueue(
      async (part) => {
        if (now < failUntilMs) throw new Error('network down');
        uploaded.push(part.seq);
      },
      {
        retryWindowMin: 15,
        now: () => now,
        sleep: async (ms) => {
          sleeps.push(ms);
          now += ms;
        },
      },
    );

    queue.enqueue(0, blob());
    queue.enqueue(1, blob());

    await vi.waitFor(() => expect(queue.pendingCount).toBe(0), { timeout: 5000 });
    expect(uploaded).toEqual([0, 1]);
    // Backoff must have been exponential and capped at 30s.
    expect(Math.max(...sleeps)).toBe(30_000);
  });

  it('stops retrying a part once its window expires, and resumes only on a manual retry()', async () => {
    let now = 0;
    let shouldFail = true;
    const uploaded: number[] = [];
    const expired: number[] = [];

    const queue = new PartUploadQueue(
      async (part) => {
        if (shouldFail) throw new Error('down');
        uploaded.push(part.seq);
      },
      {
        retryWindowMin: 1, // 60_000ms window for this test
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
        onWindowExpired: (seq) => expired.push(seq),
      },
    );

    queue.enqueue(0, blob());
    await vi.waitFor(() => expect(expired).toEqual([0]));
    expect(queue.pendingCount).toBe(1); // still queued, not dropped

    shouldFail = false;
    queue.retry();
    await vi.waitFor(() => expect(queue.pendingCount).toBe(0));
    expect(uploaded).toEqual([0]);
  });

  it('rejects new parts once the queue is full, without throwing', () => {
    const capReached: number[] = [];
    const queue = new PartUploadQueue(() => new Promise(() => {}), {
      retryWindowMin: 15,
      maxQueuedParts: 2,
      onCapReached: (seq) => capReached.push(seq),
    });

    queue.enqueue(0, blob());
    queue.enqueue(1, blob());
    queue.enqueue(2, blob());

    expect(queue.pendingCount).toBe(2);
    expect(capReached).toEqual([2]);
  });
});
