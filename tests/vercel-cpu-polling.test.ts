import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { startVisiblePolling, type VisibilityDoc } from "../src/lib/visiblePolling";
import { ADMIN_DETAIL_ENDED_POLL_MS, ADMIN_DETAIL_POLL_MS, ADMIN_ENDED_STATUSES, ADMIN_OVERVIEW_POLL_MS, adminDetailDelayMs } from "../src/lib/agentMission/adminPolling";
import { MISSION_STATUSES, MISSION_TERMINAL } from "../src/lib/agentMission/constants";
import { config as middlewareConfig } from "../src/middleware";

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

  it("a tab opened in the background schedules nothing until it is shown", () => {
    const tick = vi.fn();
    const doc = fakeDoc("hidden");
    const stop = startVisiblePolling(tick, 1000, doc);
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

describe("the middleware matcher", () => {
  const matches = (path: string) => middlewareConfig.matcher.some((m) => {
    if (!m.startsWith("/((")) return new RegExp(`^${m.replace("/:path*", "(/.*)?")}$`).test(path);
    return new RegExp(`^${m}$`).test(path);
  });
  it("static files in public/ never run it", () => {
    for (const p of ["/favicon.ico", "/site.webmanifest", "/samples/diger-sample-companies.xlsx", "/fonts/x.woff2", "/fonts/x.woff", "/brand/diger-mark.svg", "/og-image.png", "/instapay-qr.jpeg", "/_next/static/chunks/a.js"]) expect(matches(p), p).toBe(false);
  });
  it("every page and API path still runs it (session refresh and the dashboard/admin checks are unchanged)", () => {
    for (const p of ["/", "/dashboard", "/dashboard/chat", "/admin", "/admin/agent", "/api/requests", "/api/missions/x", "/login", "/robots.txt", "/sitemap.xml", "/legal/terms"]) expect(matches(p), p).toBe(true);
  });
});
