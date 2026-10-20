/**
 * The notifications panel is also refreshed by polling: live delivery (Realtime) is only a bonus, because a notification
 * written while the page is open (a job that finished) must show without a reload even when no live event arrives.
 */
export const NOTIFICATION_POLL_MS = 20_000;

type Listenable = { addEventListener: (type: string, listener: () => void) => void; removeEventListener: (type: string, listener: () => void) => void };

export interface NotificationPollingOptions {
  load: () => void | Promise<void>;
  intervalMs?: number;
  /** False while the tab is in the background: nothing is fetched for a page nobody is looking at. */
  isVisible?: () => boolean;
  /** Fires `visibilitychange` (the document) and `focus` (the window). */
  visibilityTarget?: Listenable;
  focusTarget?: Listenable;
}

/** Starts the refresh loop and returns the function that stops it. A refresh never starts while the previous one is still running. */
export function startNotificationPolling(options: NotificationPollingOptions): () => void {
  const intervalMs = options.intervalMs ?? NOTIFICATION_POLL_MS;
  const isVisible = options.isVisible ?? (() => true);
  let running = false;
  let stopped = false;

  const refresh = () => {
    if (stopped || running || !isVisible()) return;
    running = true;
    void Promise.resolve()
      .then(() => options.load())
      .catch(() => undefined)
      .finally(() => { running = false; });
  };

  const timer = setInterval(refresh, intervalMs);
  options.visibilityTarget?.addEventListener("visibilitychange", refresh);
  options.focusTarget?.addEventListener("focus", refresh);

  return () => {
    stopped = true;
    clearInterval(timer);
    options.visibilityTarget?.removeEventListener("visibilitychange", refresh);
    options.focusTarget?.removeEventListener("focus", refresh);
  };
}
