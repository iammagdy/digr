/**
 * The notifications panel (and the top-up status) are refreshed by polling, never by a live (Realtime) connection: a notification
 * written while the page is open (a job that finished) must show without a reload, and a room of 500 phones must not hold 500 open
 * connections against the free plan's ceiling of 200.
 */
export const NOTIFICATION_POLL_MS = 20_000;

type Listenable = { addEventListener: (type: string, listener: () => void) => void; removeEventListener: (type: string, listener: () => void) => void };

export interface NotificationPollingOptions {
  /** The full refresh: runs when the tab comes back to the front and, without `tick`, on every timer tick. */
  load: () => void | Promise<void>;
  /**
   * The cheap check run on each timer tick instead of `load` (for example «anything newer than what I already have?»). It returns true
   * when it found something new; a quiet tick lets the next delay grow (see `backoff`), a tick that found something resets it.
   */
  tick?: () => boolean | void | Promise<boolean | void>;
  intervalMs?: number;
  /** ±share of the delay chosen at random so a room of phones does not ask in the same second (0 = none, the default). */
  jitter?: number;
  /** After each quiet tick the delay is multiplied by `factor`, never above `maxIntervalMs`; coming back to the tab resets it. */
  backoff?: { factor: number; maxIntervalMs: number };
  /** A random number in [0, 1): a test passes a fixed one. */
  random?: () => number;
  /** How much longer every wait is right now (1 normally, 3 while the service runs at reduced capacity). Read at every delay. */
  slowFactor?: () => number;
  /** False while the tab is in the background: nothing is fetched for a page nobody is looking at. */
  isVisible?: () => boolean;
  /** Fires `visibilitychange` (the document) and `focus` (the window). */
  visibilityTarget?: Listenable;
  focusTarget?: Listenable;
}

/** Starts the refresh loop and returns the function that stops it. A refresh never starts while the previous one is still running. */
export function startNotificationPolling(options: NotificationPollingOptions): () => void {
  const baseMs = options.intervalMs ?? NOTIFICATION_POLL_MS;
  const isVisible = options.isVisible ?? (() => true);
  const random = options.random ?? Math.random;
  const jitter = Math.min(Math.max(options.jitter ?? 0, 0), 0.5);
  let currentMs = baseMs;
  let running = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const nextDelay = () => {
    const unit = Number.isFinite(random()) ? Math.min(Math.max(random(), 0), 0.999999) : 0.5;
    const slow = Math.min(Math.max(options.slowFactor?.() ?? 1, 1), 10);
    return Math.max(1_000, Math.round(currentMs * (1 + (unit * 2 - 1) * jitter) * (Number.isFinite(slow) ? slow : 1)));
  };
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(onTimer, nextDelay());
  };
  const run = (job: () => boolean | void | Promise<boolean | void>, quietGrows: boolean): Promise<void> | undefined => {
    if (stopped || running || !isVisible()) return undefined;
    running = true;
    return Promise.resolve()
      .then(() => job())
      .then((found) => {
        if (!quietGrows || !options.backoff) return;
        currentMs = found ? baseMs : Math.min(Math.round(currentMs * options.backoff.factor), options.backoff.maxIntervalMs);
      })
      .catch(() => undefined)
      .finally(() => { running = false; });
  };
  // The next delay is chosen after the check finished, so what it found (or did not find) decides it.
  const onTimer = () => {
    const pending = run(options.tick ?? options.load, Boolean(options.tick));
    if (pending) void pending.then(schedule); else schedule();
  };
  // Coming back to the tab (or the window) refreshes everything at once and starts the delays again from the shortest.
  const refreshAll = () => {
    currentMs = baseMs;
    void run(options.load, false);
  };

  schedule();
  options.visibilityTarget?.addEventListener("visibilitychange", refreshAll);
  options.focusTarget?.addEventListener("focus", refreshAll);

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    options.visibilityTarget?.removeEventListener("visibilitychange", refreshAll);
    options.focusTarget?.removeEventListener("focus", refreshAll);
  };
}
