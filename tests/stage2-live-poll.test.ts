import { describe, expect, it } from "vitest";
import { LIVE_SHEET_POLL, counterAr, nextPollDelayMs, parsePollRequest, pollResponse, type LiveSnapshot } from "../src/lib/agentMission/stage2/liveSheet";

/** STAGE 2 (docs/STAGE-2.md), THE POLLING CONTRACT of the live sheet (no Realtime on the free plan): a cursor, an adaptive interval, and a bounded answer. Pure. */
const snapshot = (rows: number, cellChars = 10, status: "running" | "done" = "running"): LiveSnapshot => ({
  v: 1, missionId: "m", cursor: `7.3.${status}`, status, delivered: rows, promised: 40, counterAr: counterAr(rows, 40), workLog: Array.from({ length: 30 }, (_, i) => ({ code: "page_read" as const, at: i, timeAr: "١٠:٣٠", textAr: "قرأنا صفحتين من المصدر حتى الآن." })),
  sheets: [
    { stageKey: "videos", nameAr: "الفيديوهات", headers: ["النص", "المعرّف"], rows: [{ id: "v1", parentId: null, cells: [{ k: "text", v: "ن" }] }] },
    { stageKey: "comments", nameAr: "التعليقات", headers: ["نص التعليق", "المعرّف", "معرّف الأصل"], rows: Array.from({ length: rows }, (_, i) => ({ id: `c${i}`, parentId: "v1", cells: [{ k: "text" as const, v: "ت".repeat(cellChars) }] })) },
  ],
  builtAt: 0,
});

describe("the request", () => {
  it("is clamped: a limit of 1 to 200 (50 by default), an offset of 0 or more, a bounded cursor", () => {
    expect(parsePollRequest(new URLSearchParams(""))).toEqual({ cursor: null, sheet: null, offset: 0, limit: 50 });
    expect(parsePollRequest(new URLSearchParams("limit=100000&offset=-3&cursor=abc&sheet=comments"))).toEqual({ cursor: "abc", sheet: "comments", offset: 0, limit: 200 });
    expect(parsePollRequest({ limit: "0", offset: "12" })).toEqual({ cursor: null, sheet: null, offset: 12, limit: 50 });
    expect(parsePollRequest({ cursor: "x".repeat(201) }).cursor).toBeNull();
  });
});

describe("the answer", () => {
  it("no snapshot yet (or the flag is off): an empty answer that tells the screen to wait the longest interval", () => {
    expect(pollResponse(null, parsePollRequest({}))).toEqual({ changed: false, cursor: null, retryAfterMs: LIVE_SHEET_POLL.maxIntervalMs, empty: true });
  });
  it("the same cursor: «nothing changed», a few bytes", () => {
    const s = snapshot(10);
    const r = pollResponse(s, { cursor: s.cursor, sheet: null, offset: 0, limit: 50 });
    expect(r).toEqual({ changed: false, cursor: s.cursor, retryAfterMs: LIVE_SHEET_POLL.intervalMs });
    expect(JSON.stringify(r).length).toBeLessThan(100);
  });
  it("a new cursor: the counter «X من N», the newest 20 work-log lines, every sheet's headers and total, one window of the asked sheet", () => {
    const s = snapshot(120);
    const r = pollResponse(s, { cursor: "old", sheet: "comments", offset: 100, limit: 50 });
    if (!r.changed) throw new Error("unchanged");
    expect(r.counterAr).toBe("١٢٠ من ٤٠");
    expect(r.workLog).toHaveLength(20);
    expect(r.sheets.map((x) => [x.stageKey, x.total])).toEqual([["videos", 1], ["comments", 120]]);
    expect(r.window.stageKey).toBe("comments");
    expect(r.window.rows.map((x) => x.id)).toEqual(Array.from({ length: 20 }, (_, i) => `c${100 + i}`));
    expect(r.truncated).toBe(false);
  });
  it("no sheet asked: the first sheet", () => {
    const r = pollResponse(snapshot(3), { cursor: null, sheet: null, offset: 0, limit: 50 });
    expect(r.changed && r.window.stageKey).toBe("videos");
  });
  it("a long cell is cut in the answer (the file keeps it whole), and the window shrinks to stay under the size limit", () => {
    const r = pollResponse(snapshot(200, 2000), { cursor: null, sheet: "comments", offset: 0, limit: 200 });
    if (!r.changed) throw new Error("unchanged");
    expect(r.window.rows[0].cut).toBe(true);
    expect(r.window.rows[0].cells[0].v.length).toBe(LIVE_SHEET_POLL.maxCellChars + 1);
    expect(new TextEncoder().encode(JSON.stringify(r)).length).toBeLessThanOrEqual(LIVE_SHEET_POLL.maxPayloadBytes);
  });
  it("done: the screen is told to stop polling (no retry)", () => {
    const r = pollResponse(snapshot(5, 10, "done"), { cursor: null, sheet: null, offset: 0, limit: 10 });
    expect(r.changed && r.retryAfterMs).toBeNull();
  });
});

describe("the interval", () => {
  it("is the base interval while things change, grows while nothing does, and stays inside 3 to 30 seconds with jitter", () => {
    expect(nextPollDelayMs(5000, true, () => 0.5)).toBe(5000);
    expect(nextPollDelayMs(5000, false, () => 0.5)).toBe(7500);
    expect(nextPollDelayMs(25_000, false, () => 0.5)).toBe(30_000);
    for (const r of [0, 0.25, 0.5, 0.75, 0.999]) for (const prev of [0, 3000, 5000, 20_000, 60_000]) for (const changed of [true, false]) {
      const d = nextPollDelayMs(prev, changed, () => r);
      expect(d).toBeGreaterThanOrEqual(LIVE_SHEET_POLL.minIntervalMs);
      expect(d).toBeLessThanOrEqual(LIVE_SHEET_POLL.maxIntervalMs);
    }
  });
});
