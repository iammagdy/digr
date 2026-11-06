import { LIVE_SHEET_POLL, nextPollDelayMs, type LivePollResponse } from "./liveSheet";

/**
 * STAGE 2 S8 (docs/STAGE-2.md): THE LIVE SHEET'S POLLING LOOP, pure (no React, no network of its own), so a test can drive it with a fake clock. Polling only, never Supabase Realtime
 * (the free plan has none). It asks the route with its cursor and window, waits `nextPollDelayMs` between asks (longer while nothing changes), PAUSES while the tab is hidden (no request
 * at all), and STOPS when the job is done (`retryAfterMs: null`) or when no snapshot exists three times in a row (the flag is off or the worker writes none: today's panel stays).
 */
export type LiveData = Extract<LivePollResponse, { changed: true }>;
export interface LiveWindow { sheet: string | null; offset: number; limit: number }
export type LiveEnd = "done" | "empty" | "stopped";
/** «off»: the route answered «not found» (the flag is off for the viewer, or not their mission). `null`: the ask failed (network, a server error): a passing failure, asked again later. */
export type LiveFetchResult = LivePollResponse | "off" | null;
export interface LivePollerOptions {
  fetchPage: (q: { cursor: string | null } & LiveWindow) => Promise<LiveFetchResult>;
  onData: (d: LiveData) => void;
  onEnd?: (why: LiveEnd) => void;
  /** After each ask: whether it reached the route (`false`: a passing failure; the screen keeps the last data and may say it will try again). */
  onReach?: (reached: boolean, answer: "data" | "unchanged" | "waiting" | "off" | "failed") => void;
  /**
   * Whether the MISSION still works (the request card knows). While it does, «no snapshot yet» is not the end: the worker writes its first snapshot only with its first saved items, which can be
   * minutes after an approval, so the loop keeps asking (slower and slower, at most every 30 s). Once the mission has ended, three answers in a row with no news end the loop (the done
   * snapshot is written right after the settlement; nothing comes after it). Not given: the original rule (three «no snapshot» answers end it).
   */
  isMissionLive?: () => boolean;
  isHidden?: () => boolean;
  random?: () => number;
  /** A timer (the tests pass a fake one). Returns its cancel. */
  schedule?: (fn: () => void, ms: number) => () => void;
}
export interface LivePoller { stop(): void; setWindow(w: Partial<LiveWindow>): void; refresh(): void }
export interface LivePollerStart { cursor?: string | null; window?: Partial<LiveWindow> }

export const LIVE_EMPTY_LIMIT = 3;

export function startLivePolling(o: LivePollerOptions, start: LivePollerStart = {}): LivePoller {
  const schedule = o.schedule ?? ((fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); });
  const hidden = o.isHidden ?? (() => typeof document !== "undefined" && document.visibilityState === "hidden");
  // a page that comes back (another screen, a reload) may start from the last data it held: its cursor and its window, so the first answer is «nothing changed» when nothing did
  let cursor: string | null = start.cursor ?? null;
  let win: LiveWindow = { sheet: null, offset: 0, limit: LIVE_SHEET_POLL.defaultRowsPerResponse, ...start.window };
  let delay: number = LIVE_SHEET_POLL.intervalMs;
  let empties = 0;
  let stopped = false;
  // DONE is not STOPPED: the results stay on screen and the customer still turns pages and sheets; each of those is ONE ask (no loop: the done snapshot is the last one). The same holds
  // after an «empty» end of a mission that has ended (the last snapshot shown stays usable). Only `stop()` (the page left) ends everything.
  let done = false;
  let inFlight = false;
  let pendingWindow = false;
  let cancel: (() => void) | null = null;
  const end = (why: LiveEnd) => { if (stopped || done) return; if (why === "stopped") stopped = true; else done = true; cancel?.(); cancel = null; o.onEnd?.(why); };
  const later = (ms: number) => { cancel?.(); cancel = schedule(() => { void run(); }, ms); };
  async function run(): Promise<void> {
    if (stopped || inFlight) return;
    // a hidden tab asks nothing: it checks again later, and a visible tab is refreshed by the page's own visibility event
    if (!done && hidden()) { later(LIVE_SHEET_POLL.maxIntervalMs); return; }
    inFlight = true;
    let r: LiveFetchResult = null;
    try { r = await o.fetchPage({ cursor, ...win }); } catch { r = null; }
    inFlight = false;
    if (stopped) return;
    o.onReach?.(r !== null, r === null ? "failed" : r === "off" ? "off" : r.changed ? "data" : "empty" in r && r.empty ? "waiting" : "unchanged");
    // the customer turned a page while this ask was out: its answer is for the old window, so it is dropped and the new window is asked at once
    if (pendingWindow) { pendingWindow = false; void run(); return; }
    if (done) { if (r && r !== "off" && r.changed) { cursor = r.cursor; o.onData(r); } return; }
    if (r && r !== "off" && r.changed) {
      empties = 0;
      cursor = r.cursor;
      o.onData(r);
      if (r.retryAfterMs === null) { end("done"); return; }
      delay = nextPollDelayMs(delay, true, o.random);
    } else {
      const off = r === "off";
      const waiting = r !== null && r !== "off" && "empty" in r && r.empty === true;
      // the rules for the end: the route is off (always counted); no snapshot (counted unless the mission still works); once the mission has ended, ANY answer with no news is counted,
      // a failed ask too (a route that keeps failing for a finished mission is not asked for the rest of the page's life)
      const missionLive = o.isMissionLive ? o.isMissionLive() : null;
      const counts = off || (waiting && missionLive !== true) || missionLive === false;
      if (counts) { empties += 1; if (empties >= LIVE_EMPTY_LIMIT) { end("empty"); return; } }
      else if (r !== null) empties = 0;
      delay = nextPollDelayMs(delay, false, o.random);
    }
    later(delay);
  }
  void run();
  return {
    stop: () => { if (done) { stopped = true; return; } end("stopped"); },
    // a new window is a new question: the cursor is dropped so the answer carries the rows of that window (after the end too: one ask)
    setWindow: (w) => { win = { ...win, ...w }; cursor = null; if (!stopped) { if (!done) delay = LIVE_SHEET_POLL.intervalMs; if (inFlight) pendingWindow = true; else void run(); } },
    refresh: () => { if (!stopped && !done) void run(); },
  };
}
