import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { startVisiblePolling, type VisibilityDoc } from "../src/lib/visiblePolling";
import { ADMIN_DETAIL_ENDED_POLL_MS, ADMIN_DETAIL_POLL_MS, ADMIN_ENDED_STATUSES, ADMIN_OVERVIEW_POLL_MS, adminDetailDelayMs } from "../src/lib/agentMission/adminPolling";
import { MISSION_STATUSES, MISSION_TERMINAL } from "../src/lib/agentMission/constants";
import { config as middlewareConfig } from "../src/middleware";
import * as pageStaticInfo from "next/dist/build/analysis/get-page-static-info";

/** Next's own matcher compiler (the build calls it on `config.matcher`); exported at runtime but not in its type declarations. */
const getMiddlewareMatchers = (pageStaticInfo as unknown as { getMiddlewareMatchers: (matchers: unknown, nextConfig: unknown) => Array<{ regexp: string }> }).getMiddlewareMatchers;

/** VERCEL ACTIVE CPU (docs/ops/VERCEL-CPU.md): a background admin tab asks the server nothing; what a visible tab reads is unchanged. */
function fakeDoc(state: "visible" | "hidden" = "visible") {
  const listeners = new Set<() => void>();
  const doc: VisibilityDoc & { set(s: "visible" | "hidden"): void; listeners: Set<() => void> } = {
    visibilityState: state,
    addEventListener: (_t, fn) => { listeners.add(fn); },
    removeEventListener: (_t, fn) => { listeners.delete(fn); },
    set(s) { this.visibilityState = s; for (const fn of [...listeners]) fn(); },
    listeners,
  };
  return doc;
}

describe("startVisiblePolling", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("a visible tab asks on the interval, exactly as a setInterval did", () => {
    const tick = vi.fn();
    const stop = startVisiblePolling(tick, 3000, fakeDoc());
    vi.advanceTimersByTime(2999); expect(tick).toHaveBeenCalledTimes(0);
    vi.advanceTimersByTime(1); expect(tick).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(30_000); expect(tick).toHaveBeenCalledTimes(11);
    stop();
  });

  it("a hidden tab asks NOTHING, however long it stays hidden; it asks once at once when shown, then on the interval again", () => {
    const tick = vi.fn();
    const doc = fakeDoc();
    const stop = startVisiblePolling(tick, 3000, doc);
    vi.advanceTimersByTime(3000); expect(tick).toHaveBeenCalledTimes(1);
    doc.set("hidden");
    vi.advanceTimersByTime(24 * 3_600_000); expect(tick).toHaveBeenCalledTimes(1);
    doc.set("visible"); expect(tick).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(3000); expect(tick).toHaveBeenCalledTimes(3);
    stop();
  });

  it("hidden means NO pending timer at all (not a timer that wakes up to do nothing); a visibilitychange to visible while already visible never stacks a second timer", () => {
    const tick = vi.fn();
    const doc = fakeDoc();
    const stop = startVisiblePolling(tick, 3000, doc);
    expect(vi.getTimerCount()).toBe(1);
    doc.set("hidden");
    expect(vi.getTimerCount()).toBe(0);
    doc.set("visible");
    expect(vi.getTimerCount()).toBe(1);
    doc.set("visible"); doc.set("visible");
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(3000);
    expect(tick).toHaveBeenCalledTimes(4);
    stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a tab that turned hidden without an event (a browser that misses it) still asks nothing when the timer fires", () => {
    const tick = vi.fn();
    const doc = fakeDoc();
    const stop = startVisiblePolling(tick, 1000, doc);
    doc.visibilityState = "hidden";
    vi.advanceTimersByTime(60_000);
    expect(tick).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    stop();
  });

  it("a tab opened in the background schedules nothing until it is shown", () => {
    const tick = vi.fn();
    const doc = fakeDoc("hidden");
    const stop = startVisiblePolling(tick, 1000, doc);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000); expect(tick).not.toHaveBeenCalled();
    doc.set("visible"); expect(tick).toHaveBeenCalledTimes(1);
    stop();
  });

  it("stop ends everything: no tick, no listener left behind (a visibility change after stop asks nothing)", () => {
    const tick = vi.fn();
    const doc = fakeDoc();
    const stop = startVisiblePolling(tick, 1000, doc);
    stop();
    expect(doc.listeners.size).toBe(0);
    vi.advanceTimersByTime(10_000); doc.set("hidden"); doc.set("visible");
    expect(tick).not.toHaveBeenCalled();
  });

  it("the delay is read before every wait (a caller can slow down without restarting), and flipping visibility never stacks two timers", () => {
    const tick = vi.fn();
    let delay = 1000;
    const doc = fakeDoc();
    const stop = startVisiblePolling(tick, () => delay, doc);
    vi.advanceTimersByTime(1000); expect(tick).toHaveBeenCalledTimes(1);
    // the wait already running keeps its length (the page learns the new status from the answer of the tick that just ran); every later wait is the new one
    delay = 60_000;
    vi.advanceTimersByTime(1000); expect(tick).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(59_999); expect(tick).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1); expect(tick).toHaveBeenCalledTimes(3);
    doc.set("hidden"); doc.set("visible"); doc.set("hidden"); doc.set("visible");
    expect(tick).toHaveBeenCalledTimes(5);
    vi.advanceTimersByTime(59_999); expect(tick).toHaveBeenCalledTimes(5);
    vi.advanceTimersByTime(1); expect(tick).toHaveBeenCalledTimes(6);
    stop();
  });

  it("without a document (server render) nothing is scheduled", () => {
    const tick = vi.fn();
    const stop = startVisiblePolling(tick, 10, null);
    vi.advanceTimersByTime(1000);
    expect(tick).not.toHaveBeenCalled();
    stop();
  });
});

describe("the admin console's refresh", () => {
  it("an ended mission (exactly MISSION_TERMINAL) is refreshed once a minute; a mission that can still change, every 3 seconds as before", () => {
    expect([...ADMIN_ENDED_STATUSES].sort()).toEqual([...MISSION_TERMINAL].sort());
    for (const s of MISSION_STATUSES) expect(adminDetailDelayMs(s), s).toBe(MISSION_TERMINAL.has(s) ? ADMIN_DETAIL_ENDED_POLL_MS : ADMIN_DETAIL_POLL_MS);
    expect(adminDetailDelayMs(null)).toBe(ADMIN_DETAIL_POLL_MS);
    expect(adminDetailDelayMs(undefined)).toBe(ADMIN_DETAIL_POLL_MS);
    expect([ADMIN_DETAIL_POLL_MS, ADMIN_OVERVIEW_POLL_MS, ADMIN_DETAIL_ENDED_POLL_MS]).toEqual([3000, 10_000, 60_000]);
  });

  it("no admin screen keeps a bare setInterval to the server: every timed refresh goes through startVisiblePolling", () => {
    for (const f of ["src/app/admin/agent/page.tsx", "src/app/admin/operations/page.tsx", "src/components/admin/AdminShell.tsx", "src/components/admin/FreeRerunPanel.tsx"]) {
      const src = readFileSync(f, "utf8");
      expect(src, f).toContain("startVisiblePolling(");
      expect(src, f).not.toMatch(/setInterval\([^)]*(load|refresh)/);
    }
    const agent = readFileSync("src/app/admin/agent/page.tsx", "utf8");
    expect(agent).toContain("adminDetailDelayMs(detailStatus.current)");
    expect(agent).toContain("startVisiblePolling(() => { void loadOverview(); }, ADMIN_OVERVIEW_POLL_MS)");
    // the sidebar still asks for the same fresh provider check (model-planner-admin-selftest pins the URL)
    expect(readFileSync("src/components/admin/AdminShell.tsx", "utf8")).toContain('"/api/admin/providers?refresh=true"');
  });
});

describe("the middleware matcher (compiled by Next itself: getMiddlewareMatchers, the same function the build uses)", () => {
  const compiled = getMiddlewareMatchers(middlewareConfig.matcher, {}).map((m) => new RegExp(m.regexp));
  const runs = (path: string) => compiled.some((re: RegExp) => re.test(path));

  it("the compiler is Next's real one (one compiled matcher per source)", () => {
    expect(typeof getMiddlewareMatchers).toBe("function");
    expect(compiled).toHaveLength(middlewareConfig.matcher.length);
  });

  it("1. the PUBLIC sample spreadsheets skip it", () => {
    for (const p of ["/samples/diger-sample-companies.xlsx", "/samples/diger-sample-comments.xlsx", "/samples/diger-sample-decision-makers.xlsx"]) expect(runs(p), p).toBe(false);
  });

  it("2. every other path ending in .xlsx still runs it: API download routes (today's and any future one), nested or look-alike sample paths", () => {
    for (const p of ["/api/jobs/abc/download.xlsx", "/api/missions/m1/file.xlsx", "/api/admin/export.xlsx", "/api/samples/x.xlsx", "/report.xlsx", "/samples/nested/x.xlsx", "/xsamples/x.xlsx", "/files/samples/x.xlsx"]) expect(runs(p), p).toBe(true);
  });

  it("3. admin and dashboard protection is unchanged: every /admin and /dashboard path runs it, whatever its ending", () => {
    for (const p of ["/admin", "/admin/agent", "/admin/export", "/admin/x.xlsx", "/admin/logo.png", "/dashboard", "/dashboard/chat", "/dashboard/requests", "/dashboard/x.xlsx", "/dashboard/a.svg"]) expect(runs(p), p).toBe(true);
    // and every page and API path still runs it (session refresh)
    for (const p of ["/", "/login", "/api/requests", "/api/missions/x", "/api/chat", "/robots.txt", "/sitemap.xml", "/legal/terms"]) expect(runs(p), p).toBe(true);
  });

  it("4. static assets still skip it where intended", () => {
    for (const p of ["/favicon.ico", "/favicon-32x32.png", "/site.webmanifest", "/fonts/x.woff2", "/fonts/x.woff", "/x.ttf", "/brand/diger-mark.svg", "/og-image.png", "/instapay-qr.jpeg", "/_next/static/chunks/a.js", "/_next/image"]) expect(runs(p), p).toBe(false);
  });

  it("the source keeps the spreadsheet exception to /samples/ only (no global .xlsx in the extension list)", () => {
    const src = readFileSync("src/middleware.ts", "utf8");
    expect(src).toContain("samples/[^/]+\\\\.xlsx$");
    expect(src).not.toMatch(/\|xlsx\)\$/);
  });
});
