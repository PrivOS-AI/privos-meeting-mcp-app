/**
 * Screen Wake Lock — keeps the screen (and, on many mobile OSes, the mic)
 * alive while recording. `acquire()` MUST be called from inside the "Start
 * recording" click handler (a user gesture is required by the API). Re-acquires on
 * `visibilitychange` (the sentinel is revoked whenever the tab is hidden) and
 * releases on pause/End/error. The iframe is `srcdoc` opaque-origin, so this
 * only works once the Hub grants `allow="screen-wake-lock"` — until then
 * every `request()` throws `NotAllowedError` and the caller falls back to the
 * `keep-awake-notice` banner (recording itself never depends on this).
 */
export interface WakeLockState {
  supported: boolean;
  active: boolean;
  error?: string;
}

export interface ScreenWakeLockOptions {
  onChange(state: WakeLockState): void;
}

/** Minimal shape of `navigator.wakeLock` — not in every lib.dom.d.ts version this repo's TS targets. */
interface WakeLockSentinelLike extends EventTarget {
  released: boolean;
  release(): Promise<void>;
  addEventListener(type: 'release', listener: () => void): void;
}
interface WakeLockNavigator {
  wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinelLike> };
}

export class ScreenWakeLock {
  private sentinel: WakeLockSentinelLike | null = null;
  private visibilityHandler: (() => void) | null = null;
  private state: WakeLockState;

  constructor(private readonly opts: ScreenWakeLockOptions) {
    const supported = Boolean((navigator as WakeLockNavigator).wakeLock);
    this.state = { supported, active: false };
  }

  getState(): WakeLockState {
    return this.state;
  }

  private setState(patch: Partial<WakeLockState>): void {
    this.state = { ...this.state, ...patch };
    this.opts.onChange(this.state);
  }

  /** Call from inside the user gesture that starts recording. */
  async acquire(): Promise<void> {
    const wakeLock = (navigator as WakeLockNavigator).wakeLock;
    if (!wakeLock) {
      this.setState({ supported: false, active: false, error: 'unsupported' });
      return;
    }
    try {
      const sentinel = await wakeLock.request('screen');
      this.sentinel = sentinel;
      this.setState({ supported: true, active: true, error: undefined });
      sentinel.addEventListener('release', () => {
        this.setState({ active: false });
      });
      if (!this.visibilityHandler) {
        this.visibilityHandler = () => {
          if (document.visibilityState === 'visible' && !this.state.active) void this.acquire();
        };
        document.addEventListener('visibilitychange', this.visibilityHandler);
      }
    } catch (error) {
      const name = error instanceof DOMException ? error.name : 'unknown';
      this.setState({ supported: true, active: false, error: name });
    }
  }

  async release(): Promise<void> {
    if (this.visibilityHandler) {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.visibilityHandler = null;
    }
    if (this.sentinel && !this.sentinel.released) {
      await this.sentinel.release();
    }
    this.sentinel = null;
    this.setState({ active: false });
  }
}
