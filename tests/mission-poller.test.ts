import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startMissionPolling } from "../src/lib/missionPoller";

/**
 * LIVE RETEST 2026-10-31 16:41-16:48 (B5, YouTube): the card stayed on «الخطوة الحالية تستغرق وقتًا أطول من المعتاد» and showed the plan only after a page reload, although the plan was stored at 16:46:35 and the customer approved at 16:48:07.
 * The card's loop read, AWAITED the read, and only then armed the next one: a read that never settled (a request that hangs after a network change, a session read that waits for a lock) ended the loop for good; only a reload restarted it.
 * The loop must be unkillable by one read: every read has a limit, a read that fails or never answers is followed by the next, and a new loop never revives an old one.
 */
describe("the card's polling loop", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("a read that NEVER settles does not end the loop: the next read is made after its limit", async () => {
    const reads: number[] = [];
    const stop = startMissionPolling({ read: () => { reads.push(reads.length); return reads.length === 1 ? new Promise<void>(() => undefined) : Promise.resolve(); }, nextDelayMs: () => 8_000, readTimeoutMs: 15_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(reads).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(15_000 + 8_000 + 10);
    expect(reads.length).toBeGreaterThanOrEqual(2);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(reads.length).toBeGreaterThanOrEqual(3);
    stop();
  });

  it("a read that throws is followed by the next one at the normal pace", async () => {
    let n = 0;
    const stop = startMissionPolling({ read: async () => { n += 1; if (n === 1) throw new Error("network"); }, nextDelayMs: () => 8_000, readTimeoutMs: 15_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(n).toBe(1);
    await vi.advanceTimersByTimeAsync(8_010);
    expect(n).toBe(2);
    stop();
  });

  it("the pace is asked again before every read (a mission that went live reads faster)", async () => {
    let n = 0;
    let delay = 8_000;
    const stop = startMissionPolling({ read: async () => { n += 1; }, nextDelayMs: () => delay, readTimeoutMs: 15_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(n).toBe(1);
    delay = 2_000;
    await vi.advanceTimersByTimeAsync(8_010);
    expect(n).toBe(2);
    await vi.advanceTimersByTimeAsync(2_010);
    expect(n).toBe(3);
    stop();
  });

  it("stop() ends it: no read after it, not even the one a slow read was about to arm", async () => {
    let n = 0;
    let release: () => void = () => undefined;
    const stop = startMissionPolling({ read: () => { n += 1; return new Promise<void>((res) => { release = res; }); }, nextDelayMs: () => 1_000, readTimeoutMs: 15_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(n).toBe(1);
    stop();
    release();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(n).toBe(1);
  });

  it("two loops are independent: stopping the old one (the card's pace changed) does not stop the new one, and does not let the old one come back", async () => {
    let a = 0;
    let b = 0;
    const stopA = startMissionPolling({ read: async () => { a += 1; }, nextDelayMs: () => 1_000, readTimeoutMs: 15_000 });
    await vi.advanceTimersByTimeAsync(0);
    stopA();
    const stopB = startMissionPolling({ read: async () => { b += 1; }, nextDelayMs: () => 1_000, readTimeoutMs: 15_000 });
    await vi.advanceTimersByTimeAsync(5_050);
    expect(a).toBe(1);
    expect(b).toBeGreaterThanOrEqual(5);
    stopB();
  });
});
