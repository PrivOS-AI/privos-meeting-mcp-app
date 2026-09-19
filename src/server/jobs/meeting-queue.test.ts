import { describe, expect, it } from 'vitest';

import { MeetingQueue } from './meeting-queue.js';

describe('MeetingQueue', () => {
  it('runs one task per distinct meetingId and resolves', async () => {
    const queue = new MeetingQueue(2);
    await expect(queue.enqueue('m1', async () => undefined, 1000)).resolves.toBeUndefined();
    expect(queue.isRunning('m1')).toBe(false);
  });

  it('a second enqueue for the SAME meetingId while running returns the first promise', async () => {
    const queue = new MeetingQueue(1);
    let resolveFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const first = queue.enqueue('m1', () => gate, 1000);
    const second = queue.enqueue('m1', async () => undefined, 1000);
    expect(second).toBe(first);
    resolveFirst();
    await first;
  });

  it('startDraining rejects a brand-new enqueue with a clear message', async () => {
    const queue = new MeetingQueue(1);
    queue.startDraining();
    await expect(queue.enqueue('m2', async () => undefined, 1000)).rejects.toThrow(/shutting down/i);
  });

  it('startDraining does NOT affect a job already running for the same meetingId', async () => {
    const queue = new MeetingQueue(1);
    let resolveFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const first = queue.enqueue('m1', () => gate, 1000);
    queue.startDraining();
    // Re-enqueue of the SAME meetingId while it is still running is a no-op join, not a new job.
    const rejoin = queue.enqueue('m1', async () => undefined, 1000);
    expect(rejoin).toBe(first);
    resolveFirst();
    await expect(rejoin).resolves.toBeUndefined();
  });
});
