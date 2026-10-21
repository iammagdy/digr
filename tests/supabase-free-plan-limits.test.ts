import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NOTIFICATION_POLL_MS, startNotificationPolling } from "../src/lib/notificationPolling";

const auth = vi.hoisted(() => ({ getUserCalls: 0 }));
vi.mock("@supabase/ssr", () => ({ createServerClient: () => ({ auth: { getUser: async () => { auth.getUserCalls += 1; return { data: { user: null } }; } } }) }));
import { middleware } from "../src/middleware";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe("no page holds a live (Realtime) connection: the free plan allows 200 for the whole room", () => {
  it("nothing under src opens a channel or listens to database changes", () => {
    for (const file of sourceFiles("src")) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(/\.channel\(/);
      expect(text, file).not.toContain("postgres_changes");
      expect(text, file).not.toMatch(/\.subscribe\(\)/);
    }
  });
  it("the top-up page polls the status of a waiting request instead", () => {
    const page = readFileSync("src/app/dashboard/topup/page.tsx", "utf8");
    expect(page).toContain("startNotificationPolling");
    expect(page).toContain("hasPendingTopup");
  });
});

describe("polling is adaptive, jittered and silent in a hidden tab", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("the delay is spread by the jitter and never leaves ±20%", async () => {
    const ticks: number[] = [];
    let at = 0;
    const randoms = [0, 0.999999, 0.5];
    let i = 0;
    const stop = startNotificationPolling({ load: () => undefined, tick: () => { ticks.push(Date.now() - at); at = Date.now(); return true; }, intervalMs: 30_000, jitter: 0.2, random: () => randoms[i++ % 3] });
    at = Date.now();
    await vi.advanceTimersByTimeAsync(30_000 * 3);
    stop();
    expect(ticks.length).toBeGreaterThanOrEqual(3);
    for (const gap of ticks) { expect(gap).toBeGreaterThanOrEqual(24_000); expect(gap).toBeLessThanOrEqual(36_000); }
    expect(new Set(ticks).size).toBeGreaterThan(1);
  });

  it("quiet ticks make the next delay grow up to the ceiling; a tick that finds something starts again from the shortest", async () => {
    let found = false;
    const gaps: number[] = [];
    let last = Date.now();
    const stop = startNotificationPolling({
      load: () => undefined,
      tick: () => { gaps.push(Date.now() - last); last = Date.now(); return found; },
      intervalMs: 10_000, backoff: { factor: 2, maxIntervalMs: 40_000 }, jitter: 0, random: () => 0.5,
    });
    await vi.advanceTimersByTimeAsync(10_000 + 20_000 + 40_000 + 40_000);
    expect(gaps).toEqual([10_000, 20_000, 40_000, 40_000]);
    found = true;
    await vi.advanceTimersByTimeAsync(40_000);
    expect(gaps.at(-1)).toBe(40_000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(gaps.at(-1)).toBe(10_000);
    stop();
  });

  it("a hidden tab asks nothing; coming back reads the full list at once and resets the delay", async () => {
    let visible = false;
    const load = vi.fn();
    const tick = vi.fn(() => false);
    const listeners: Record<string, () => void> = {};
    const target = { addEventListener: (t: string, l: () => void) => { listeners[t] = l; }, removeEventListener: () => undefined };
    const stop = startNotificationPolling({ load, tick, isVisible: () => visible, visibilityTarget: target, intervalMs: 10_000, backoff: { factor: 2, maxIntervalMs: 80_000 }, jitter: 0, random: () => 0.5 });
    await vi.advanceTimersByTimeAsync(100_000);
    expect(tick).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
    visible = true;
    listeners.visibilitychange();
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(1);
    stop();
  });

  it("without options it behaves as before: a fixed interval and the full load on every tick", async () => {
    const load = vi.fn();
    const stop = startNotificationPolling({ load });
    await vi.advanceTimersByTimeAsync(NOTIFICATION_POLL_MS * 2);
    expect(load).toHaveBeenCalledTimes(2);
    stop();
  });
});

describe("the sign-in service is asked as little as possible", () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://mock.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "mock";
    auth.getUserCalls = 0;
  });

  it("an API call that carries its own bearer token costs the middleware no call (the route checks the token once)", async () => {
    await middleware(new NextRequest("http://localhost:3000/api/chat", { method: "POST", headers: { authorization: "Bearer abc" } }));
    await middleware(new NextRequest("http://localhost:3000/api/jobs/x/nudge", { method: "POST", headers: { authorization: "Bearer abc" } }));
    expect(auth.getUserCalls).toBe(0);
  });

  it("a cookie-only API call (a download link) and every page still go through the session refresh", async () => {
    await middleware(new NextRequest("http://localhost:3000/api/jobs/x/download"));
    await middleware(new NextRequest("http://localhost:3000/dashboard/chat"));
    expect(auth.getUserCalls).toBe(2);
  });

  it("the page reads its first user from the stored session; only an explicit refresh asks the service", () => {
    const hook = readFileSync("src/hooks/useUser.tsx", "utf8");
    expect(hook).toContain("readStoredSession()");
    const effect = hook.slice(hook.indexOf("const readStoredSession"), hook.indexOf("const login"));
    expect(effect).not.toContain("auth.getUser()");
    expect(hook).toContain("refresh: getUser");
  });

  it("the landing page is static: no server read of the session", () => {
    const page = readFileSync("src/app/page.tsx", "utf8");
    expect(page).toContain('export const dynamic = "force-static"');
    expect(page).not.toContain("getUser");
    expect(page).not.toContain("cookies");
  });
});
