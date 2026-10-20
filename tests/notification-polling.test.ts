import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NOTIFICATION_POLL_MS, startNotificationPolling } from "../src/lib/notificationPolling";

function fakeTarget() {
  const listeners = new Map<string, Set<() => void>>();
  return {
    addEventListener: (type: string, listener: () => void) => { (listeners.get(type) ?? listeners.set(type, new Set()).get(type)!).add(listener); },
    removeEventListener: (type: string, listener: () => void) => { listeners.get(type)?.delete(listener); },
    fire: (type: string) => listeners.get(type)?.forEach((listener) => listener()),
    count: (type: string) => listeners.get(type)?.size ?? 0,
  };
}

describe("notifications refresh by polling", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("a notification written after the page loaded shows on the next poll, with no live event", async () => {
    const server: string[] = [];
    const shown: string[] = [];
    const stop = startNotificationPolling({ load: async () => { shown.splice(0, shown.length, ...server); } });
    server.push("اكتمل طلبك جزئيًا");
    expect(shown).toEqual([]);
    await vi.advanceTimersByTimeAsync(NOTIFICATION_POLL_MS);
    expect(shown).toEqual(["اكتمل طلبك جزئيًا"]);
    stop();
  });

  it("polls on every interval while visible and not at all while the tab is in the background", async () => {
    const load = vi.fn();
    let visible = true;
    const stop = startNotificationPolling({ load, isVisible: () => visible });
    await vi.advanceTimersByTimeAsync(NOTIFICATION_POLL_MS * 3);
    expect(load).toHaveBeenCalledTimes(3);
    visible = false;
    await vi.advanceTimersByTimeAsync(NOTIFICATION_POLL_MS * 3);
    expect(load).toHaveBeenCalledTimes(3);
    stop();
  });

  it("refreshes at once when the tab comes back to the front or the window gets focus", async () => {
    const load = vi.fn();
    const doc = fakeTarget();
    const win = fakeTarget();
    const stop = startNotificationPolling({ load, visibilityTarget: doc, focusTarget: win });
    doc.fire("visibilitychange");
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(1);
    win.fire("focus");
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(2);
    stop();
  });

  it("never starts a refresh while the previous one is still running", async () => {
    let release: () => void = () => {};
    const load = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const stop = startNotificationPolling({ load });
    await vi.advanceTimersByTimeAsync(NOTIFICATION_POLL_MS * 3);
    expect(load).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(NOTIFICATION_POLL_MS);
    expect(load).toHaveBeenCalledTimes(2);
    stop();
  });

  it("a failing refresh does not stop the loop, and stopping removes the timer and the listeners", async () => {
    const load = vi.fn(async () => { throw new Error("offline"); });
    const doc = fakeTarget();
    const win = fakeTarget();
    const stop = startNotificationPolling({ load, visibilityTarget: doc, focusTarget: win });
    await vi.advanceTimersByTimeAsync(NOTIFICATION_POLL_MS * 2);
    expect(load).toHaveBeenCalledTimes(2);
    stop();
    expect(doc.count("visibilitychange")).toBe(0);
    expect(win.count("focus")).toBe(0);
    await vi.advanceTimersByTimeAsync(NOTIFICATION_POLL_MS * 3);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
