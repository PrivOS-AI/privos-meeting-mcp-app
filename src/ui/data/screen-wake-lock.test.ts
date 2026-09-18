import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ScreenWakeLock, type WakeLockState } from './screen-wake-lock.js';

class FakeSentinel {
  released = false;
  listeners: Array<() => void> = [];
  addEventListener(_type: 'release', listener: () => void): void {
    this.listeners.push(listener);
  }
  async release(): Promise<void> {
    this.released = true;
    for (const l of this.listeners) l();
  }
}

function fakeDocument() {
  const handlers = new Map<string, (() => void)[]>();
  return {
    visibilityState: 'visible' as DocumentVisibilityState,
    addEventListener: (type: string, handler: () => void) => {
      handlers.set(type, [...(handlers.get(type) ?? []), handler]);
    },
    removeEventListener: (type: string, handler: () => void) => {
      handlers.set(type, (handlers.get(type) ?? []).filter((h) => h !== handler));
    },
    fire(type: string) {
      for (const h of handlers.get(type) ?? []) h();
    },
  };
}

describe('ScreenWakeLock', () => {
  let doc: ReturnType<typeof fakeDocument>;

  beforeEach(() => {
    doc = fakeDocument();
    vi.stubGlobal('document', doc);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports unsupported when navigator.wakeLock is absent', async () => {
    vi.stubGlobal('navigator', {});
    const states: WakeLockState[] = [];
    const lock = new ScreenWakeLock({ onChange: (s) => states.push(s) });
    await lock.acquire();
    expect(states.at(-1)).toEqual({ supported: false, active: false, error: 'unsupported' });
  });

  it('acquires a sentinel and re-acquires after visibilitychange revokes it', async () => {
    const sentinel = new FakeSentinel();
    const request = vi.fn(async () => sentinel);
    vi.stubGlobal('navigator', { wakeLock: { request } });

    const states: WakeLockState[] = [];
    const lock = new ScreenWakeLock({ onChange: (s) => states.push(s) });
    await lock.acquire();

    expect(request).toHaveBeenCalledTimes(1);
    expect(lock.getState()).toEqual({ supported: true, active: true, error: undefined });

    // Simulate the OS revoking the sentinel when the tab is hidden, then shown again.
    await sentinel.release();
    expect(lock.getState().active).toBe(false);

    doc.fire('visibilitychange');
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  });

  it('surfaces NotAllowedError (Hub has not granted allow="screen-wake-lock") without throwing', async () => {
    vi.stubGlobal('navigator', {
      wakeLock: {
        request: vi.fn(async () => {
          throw new DOMException('denied', 'NotAllowedError');
        }),
      },
    });
    const lock = new ScreenWakeLock({ onChange: () => {} });
    await lock.acquire();
    expect(lock.getState()).toEqual({ supported: true, active: false, error: 'NotAllowedError' });
  });

  it('release() removes the visibilitychange listener and releases the sentinel', async () => {
    const sentinel = new FakeSentinel();
    vi.stubGlobal('navigator', { wakeLock: { request: vi.fn(async () => sentinel) } });
    const lock = new ScreenWakeLock({ onChange: () => {} });
    await lock.acquire();
    await lock.release();
    expect(sentinel.released).toBe(true);
    expect(lock.getState().active).toBe(false);
  });
});
