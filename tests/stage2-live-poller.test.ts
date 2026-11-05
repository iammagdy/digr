import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LIVE_EMPTY_LIMIT, startLivePolling, type LiveData } from "../src/lib/agentMission/stage2/livePoller";
import { LIVE_SHEET_POLL, type LivePollResponse } from "../src/lib/agentMission/stage2/liveSheet";

/**
 * STAGE 2 S8 (docs/STAGE-2.md): the live sheet's polling loop (no Realtime). It waits between asks (longer while nothing changes), pauses while the tab is hidden, stops when the job is done
 * or when there is no snapshot three times in a row, and a new window drops the cursor. Driven by a fake clock.
 */
function fakeClock() {
  const timers: Array<{ at: number; fn: () => void; id: number }> = [];
  let now = 0;
  let next = 0;
  return {
    schedule: (fn: () => void, ms: number) => { const id = (next += 1); timers.push({ at: now + ms, fn, id }); return () => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); }; },
    pending: () => timers.map((t) => t.at - now),
    async advance(ms: number) {
      now += ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const due = timers[0];
        if (!due || due.at > now) break;
        timers.shift();
        due.fn();
        await new Promise((r) => setTimeout(r, 0));
      }
    },
  };
}
const flush = () => new Promise((r) => setTimeout(r, 0));
const data = (cursor: string, done = false): LivePollResponse => ({ changed: true, cursor, status: done ? "done" : "running", delivered: 1, promised: 2, counterAr: "١ من ٢", workLog: [], sheets: [], window: { stageKey: "", offset: 0, rows: [] }, truncated: false, retryAfterMs: done ? null : 5000 });
const unchanged = (cursor: string): LivePollResponse => ({ changed: false, cursor, retryAfterMs: 5000 });
const empty: LivePollResponse = { changed: false, cursor: null, retryAfterMs: 30_000, empty: true };

describe("the loop", () => {
  it("asks once at start, shows the data, then waits about 5 seconds; while nothing changes it waits longer (never above 30 s)", async () => {
    const clock = fakeClock();
    const answers = [data("1"), unchanged("1"), unchanged("1"), unchanged("1")];
    const asked: Array<string | null> = [];
    const seen: LiveData[] = [];
    startLivePolling({ fetchPage: async (q) => { asked.push(q.cursor); return answers.shift() ?? unchanged("1"); }, onData: (d) => seen.push(d), schedule: clock.schedule, random: () => 0.5, isHidden: () => false });
    await flush();
    expect(asked).toEqual([null]);
    expect(seen).toHaveLength(1);
    expect(clock.pending()).toEqual([5000]);
    await clock.advance(5000);
    expect(asked).toEqual([null, "1"]);
    expect(clock.pending()).toEqual([7500]);
    await clock.advance(7500);
    expect(clock.pending()).toEqual([11_250]);
    await clock.advance(11_250);
    for (const d of clock.pending()) expect(d).toBeLessThanOrEqual(LIVE_SHEET_POLL.maxIntervalMs);
  });
  it("stops when the job is done (no timer left)", async () => {
    const clock = fakeClock();
    const ends: string[] = [];
    startLivePolling({ fetchPage: async () => data("9", true), onData: () => undefined, onEnd: (w) => ends.push(w), schedule: clock.schedule, isHidden: () => false });
    await flush();
    expect(ends).toEqual(["done"]);
    expect(clock.pending()).toEqual([]);
  });
  it(`stops after ${LIVE_EMPTY_LIMIT} answers with no snapshot (the flag off, or no snapshot): the page keeps today's panel`, async () => {
    const clock = fakeClock();
    const ends: string[] = [];
    let asks = 0;
    startLivePolling({ fetchPage: async () => { asks += 1; return empty; }, onData: () => undefined, onEnd: (w) => ends.push(w), schedule: clock.schedule, isHidden: () => false });
    for (let i = 0; i < 10; i += 1) await clock.advance(30_000);
    expect(asks).toBe(LIVE_EMPTY_LIMIT);
    expect(ends).toEqual(["empty"]);
  });
  it("a hidden tab asks nothing (it only checks again later); visible again, it asks", async () => {
    const clock = fakeClock();
    let hidden = true;
    let asks = 0;
    const p = startLivePolling({ fetchPage: async () => { asks += 1; return data(String(asks)); }, onData: () => undefined, schedule: clock.schedule, isHidden: () => hidden });
    await flush();
    await clock.advance(120_000);
    expect(asks).toBe(0);
    hidden = false;
    p.refresh();
    await flush();
    expect(asks).toBe(1);
  });
  it("a failed request is not an end: it asks again later", async () => {
    const clock = fakeClock();
    let asks = 0;
    startLivePolling({ fetchPage: async () => { asks += 1; if (asks === 1) throw new Error("network"); return data("2"); }, onData: () => undefined, schedule: clock.schedule, isHidden: () => false, random: () => 0.5 });
    await flush();
    await clock.advance(30_000);
    expect(asks).toBe(2);
  });
  it("a new window drops the cursor and asks at once; stop ends everything", async () => {
    const clock = fakeClock();
    const asked: Array<{ cursor: string | null; sheet: string | null; offset: number }> = [];
    const p = startLivePolling({ fetchPage: async (q) => { asked.push({ cursor: q.cursor, sheet: q.sheet, offset: q.offset }); return data("c1"); }, onData: () => undefined, schedule: clock.schedule, isHidden: () => false });
    await flush();
    p.setWindow({ sheet: "comments", offset: 50 });
    await flush();
    expect(asked[asked.length - 1]).toEqual({ cursor: null, sheet: "comments", offset: 50 });
    p.stop();
    expect(clock.pending()).toEqual([]);
  });
});

describe("the hook uses polling only", () => {
  it("no Supabase Realtime anywhere in the live sheet code", () => {
    for (const f of ["src/hooks/useLiveSheet.ts", "src/lib/agentMission/stage2/livePoller.ts", "src/app/api/missions/[id]/live/route.ts"]) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/\.channel\(|postgres_changes|\.realtime\b|\.subscribe\(/);
    }
    expect(readFileSync("src/hooks/useLiveSheet.ts", "utf8")).toContain("/live?");
  });
});
