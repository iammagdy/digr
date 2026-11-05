import { LIVE_SHEET_POLL, nextPollDelayMs, type LivePollResponse } from "./liveSheet";

/**
 * STAGE 2 S8 (docs/STAGE-2.md): THE LIVE SHEET'S POLLING LOOP, pure (no React, no network of its own), so a test can drive it with a fake clock. Polling only, never Supabase Realtime
 * (the free plan has none). It asks the route with its cursor and window, waits `nextPollDelayMs` between asks (longer while nothing changes), PAUSES while the tab is hidden (no request
 * at all), and STOPS when the job is done (`retryAfterMs: null`) or when no snapshot exists three times in a row (the flag is off or the worker writes none: today's panel stays).
 */
export type LiveData = Extract<LivePollResponse, { changed: true }>;
export interface LiveWindow { sheet: string | null; offset: number; limit: number }
export type LiveEnd = "done" | "empty" | "stopped";
export interface LivePollerOptions {
  fetchPage: (q: { cursor: string | null } & LiveWindow) => Promise<LivePollResponse | null>;
  onData: (d: LiveData) => void;
  onEnd?: (why: LiveEnd) => void;
  isHidden?: () => boolean;
  random?: () => number;
  /** A timer (the tests pass a fake one). Returns its cancel. */
  schedule?: (fn: () => void, ms: number) => () => void;
}
export interface LivePoller { stop(): void; setWindow(w: Partial<LiveWindow>): void; refresh(): void }

export const LIVE_EMPTY_LIMIT = 3;

export function startLivePolling(o: LivePollerOptions): LivePoller {
  const schedule = o.schedule ?? ((fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); });
  const hidden = o.isHidden ?? (() => typeof document !== "undefined" && document.visibilityState === "hidden");
  let cursor: string | null = null;
  let win: LiveWindow = { sheet: null, offset: 0, limit: LIVE_SHEET_POLL.defaultRowsPerResponse };
  let delay: number = LIVE_SHEET_POLL.intervalMs;
  let empties = 0;
  let stopped = false;
  let inFlight = false;
  let cancel: (() => void) | null = null;
  const end = (why: LiveEnd) => { if (stopped) return; stopped = true; cancel?.(); cancel = null; o.onEnd?.(why); };
  const later = (ms: number) => { cancel?.(); cancel = schedule(() => { void run(); }, ms); };
  async function run(): Promise<void> {
    if (stopped || inFlight) return;
    // a hidden tab asks nothing: it checks again later, and a visible tab is refreshed by the page's own visibility event
    if (hidden()) { later(LIVE_SHEET_POLL.maxIntervalMs); return; }
    inFlight = true;
    let r: LivePollResponse | null = null;
    try { r = await o.fetchPage({ cursor, ...win }); } catch { r = null; }
    inFlight = false;
    if (stopped) return;
    if (r && r.changed) {
      empties = 0;
      cursor = r.cursor;
      o.onData(r);
      if (r.retryAfterMs === null) { end("done"); return; }
      delay = nextPollDelayMs(delay, true, o.random);
    } else {
      if (r && "empty" in r && r.empty) { empties += 1; if (empties >= LIVE_EMPTY_LIMIT) { end("empty"); return; } }
      delay = nextPollDelayMs(delay, false, o.random);
    }
    later(delay);
  }
  void run();
  return {
    stop: () => end("stopped"),
    // a new window is a new question: the cursor is dropped so the answer carries the rows of that window
    setWindow: (w) => { win = { ...win, ...w }; cursor = null; if (!stopped) { delay = LIVE_SHEET_POLL.intervalMs; void run(); } },
    refresh: () => { if (!stopped) void run(); },
  };
}
