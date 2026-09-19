/** Hosts and tests inject different timer implementations; handles only need optional unref. */
export interface TimerHandle {
  unref?(): void;
}
export type SetTimer = (callback: () => void, delay: number) => TimerHandle;
export type ClearTimer = (timer: TimerHandle | null) => void;

export interface CoalescerOptions {
  intervalMs?: number;
  now?: () => number;
  setTimer?: SetTimer;
  clearTimer?: ClearTimer;
}

/** A trailing coalescer with a minimum publication interval, not a debounce that can starve. */
export class Coalescer {
  declare callback: () => void;
  declare intervalMs: number;
  declare now: () => number;
  declare setTimer: SetTimer;
  declare clearTimer: ClearTimer;
  declare last: number;
  declare timer: TimerHandle | null;
  declare closed: boolean;
  declare requests: number;
  declare ticks: number;

  constructor(callback: () => void, options: CoalescerOptions = {}) {
    this.callback = callback;
    this.intervalMs = options.intervalMs ?? 250;
    this.now = options.now ?? (() => performance.now());
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? (clearTimeout as unknown as ClearTimer);
    this.last = -Infinity;
    this.timer = null;
    this.closed = false;
    this.requests = 0;
    this.ticks = 0;
  }

  request() {
    if (this.closed) return;
    this.requests++;
    if (this.timer !== null) return;
    const delay = Math.max(0, this.intervalMs - (this.now() - this.last));
    this.timer = this.setTimer(() => {
      this.timer = null;
      if (this.closed) return;
      this.last = this.now();
      this.ticks++;
      this.callback();
    }, delay);
    this.timer?.unref?.();
  }

  setIntervalMs(value: number) {
    const pending = this.timer !== null;
    this.cancel();
    this.intervalMs = value;
    if (pending) this.request();
  }

  cancel() {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }

  dispose() {
    this.cancel();
    this.closed = true;
  }
}
