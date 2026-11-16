import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { liveAnswer } from "./helpers/stage2Live";
import { LIVE_EMPTY_LIMIT, startLivePolling, type LiveData, type LiveFetchResult } from "../src/lib/agentMission/stage2/livePoller";
import type { LivePollResponse } from "../src/lib/agentMission/stage2/liveSheet";
import { readLiveAnswer } from "../src/hooks/useLiveSheet";
import {
  LIVE_CLOSE_AR, LIVE_CUT_NOTE_AR, LIVE_EMPTY_VALUE_AR, LIVE_FINAL_TITLE_AR, LIVE_GRID_TITLE_AR, LIVE_HIDE_AR, LIVE_NEXT_ROW_AR, LIVE_PHONE_EMPTY_AR, LIVE_PREV_ROW_AR, LIVE_ROW_NUMBER_LABEL_AR, agoAr, counterPartsAr, showSheetAr, LIVE_PROGRESS_LABEL_AR, LIVE_SHEETS_LABEL_AR, LIVE_STATUS_DONE_AR, LIVE_STATUS_QUIET_AR,
  LIVE_STATUS_RECONNECT_AR, LIVE_STATUS_WAITING_AR, LIVE_STATUS_WORKING_AR,
} from "../src/lib/agentMission/stage2/liveSheetView";
import { LIVE_EMPTY_DATA, LiveSheetView } from "../src/components/mission/LiveSheetPanel";
import { lastMissionMessageIds } from "../src/lib/agentMission/stage2/livePlacement";
import { workLogLine } from "../src/lib/agentMission/stage2/workLog";
import { checkCustomerLabel, checkCustomerText } from "../src/lib/agentMission/text";

/**
 * LAUNCH ROUND OF THE LIVE SHEET: the sheet in the conversation as well as on the request page, a desktop progress, phone cards with every field reachable, ONE work-log line, and a polling
 * loop that keeps true data through failures, late answers, slow first snapshots, fast missions and turned pages after the end. Real stored rows of M12 (tests/helpers/stage2Live.ts); the
 * loop driven by a fake clock. Display and polling only: no money, no row, no file.
 */
function fakeClock() {
  const timers: Array<{ at: number; fn: () => void; id: number }> = [];
  let now = 0;
  let next = 0;
  return {
    schedule: (fn: () => void, ms: number) => { const id = (next += 1); timers.push({ at: now + ms, fn, id }); return () => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); }; },
    pending: () => timers.length,
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
const data = (cursor: string, done = false, offset = 0): LivePollResponse => ({ changed: true, cursor, status: done ? "done" : "running", delivered: 1, promised: 2, counterAr: "١ من ٢", workLog: [], sheets: [], window: { stageKey: "", offset, rows: [] }, truncated: false, retryAfterMs: done ? null : 5000 });
const unchanged = (cursor: string): LivePollResponse => ({ changed: false, cursor, retryAfterMs: 5000 });
const waiting: LivePollResponse = { changed: false, cursor: null, retryAfterMs: 30_000, empty: true };

function loop(answers: LiveFetchResult[], extra: { isMissionLive?: () => boolean; start?: { cursor?: string | null; window?: { sheet?: string | null; offset?: number } } } = {}) {
  const clock = fakeClock();
  const asked: Array<{ cursor: string | null; offset: number; sheet: string | null }> = [];
  const seen: LiveData[] = [];
  const ends: string[] = [];
  const reach: string[] = [];
  const poller = startLivePolling({
    fetchPage: async (q) => { asked.push({ cursor: q.cursor, offset: q.offset, sheet: q.sheet }); return answers.length ? answers.shift()! : null; },
    onData: (d) => seen.push(d), onEnd: (w) => ends.push(w), onReach: (_r, a) => reach.push(a), isHidden: () => false, random: () => 0.5, schedule: clock.schedule, ...(extra.isMissionLive ? { isMissionLive: extra.isMissionLive } : {}),
  }, extra.start ?? {});
  return { clock, asked, seen, ends, reach, poller };
}

describe("the loop after the end: completed results stay usable", () => {
  it("a done mission still turns pages and sheets: each turn is ONE ask, and no loop starts again", async () => {
    const l = loop([data("9", true), data("9", true, 50), data("9", true, 0)]);
    await flush();
    expect(l.ends).toEqual(["done"]);
    expect(l.clock.pending()).toBe(0);
    l.poller.setWindow({ offset: 50 });
    await flush();
    expect(l.asked[1]).toEqual({ cursor: null, offset: 50, sheet: null });
    expect(l.seen.at(-1)!.window.offset).toBe(50);
    l.poller.setWindow({ sheet: "comments", offset: 0 });
    await flush();
    expect(l.asked[2]).toEqual({ cursor: null, offset: 0, sheet: "comments" });
    await l.clock.advance(600_000);
    expect(l.asked).toHaveLength(3);
    expect(l.clock.pending()).toBe(0);
    // a refresh (the tab came back) asks nothing once the done snapshot is shown
    l.poller.refresh();
    await flush();
    expect(l.asked).toHaveLength(3);
  });
  it("a fast mission (finished before the first ask): the first answer is the done snapshot, shown at once, one ask in all", async () => {
    const l = loop([data("4", true)]);
    await flush();
    expect(l.seen).toHaveLength(1);
    expect(l.seen[0].status).toBe("done");
    expect(l.ends).toEqual(["done"]);
    await l.clock.advance(120_000);
    expect(l.asked).toHaveLength(1);
  });
  it("a turn of the page while an ask is out: the old answer is dropped and the new window is asked at once", async () => {
    let release: (v: LiveFetchResult) => void = () => undefined;
    const asked: number[] = [];
    const seen: LiveData[] = [];
    const clock = fakeClock();
    const poller = startLivePolling({
      fetchPage: (q) => { asked.push(q.offset); return asked.length === 1 ? new Promise((r) => { release = r; }) : Promise.resolve(data("2", false, q.offset)); },
      onData: (d) => seen.push(d), isHidden: () => false, random: () => 0.5, schedule: clock.schedule,
    });
    poller.setWindow({ offset: 50 });
    release(data("1", false, 0));
    await flush(); await flush();
    expect(asked).toEqual([0, 50]);
    expect(seen.map((d) => d.window.offset)).toEqual([50]);
    poller.stop();
  });
});

describe("the loop keeps true data and keeps asking while the mission works", () => {
  it("a temporary failure (network, a 5xx) never ends the loop and never erases the data shown", async () => {
    const l = loop([data("1"), null, null, null, null, null, data("2")]);
    await flush();
    for (let i = 0; i < 6; i += 1) await l.clock.advance(30_000);
    expect(l.ends).toEqual([]);
    expect(l.seen.map((d) => d.cursor)).toEqual(["1", "2"]);
    expect(l.reach.slice(0, 7)).toEqual(["data", "failed", "failed", "failed", "failed", "failed", "data"]);
    l.poller.stop();
  });
  it("no snapshot yet while the mission works (a long queue, a slow first page): the loop keeps asking, slower, never above every 30 s", async () => {
    const l = loop([...Array.from({ length: 10 }, (): LiveFetchResult => waiting), data("1")], { isMissionLive: () => true });
    await flush();
    for (let i = 0; i < 12; i += 1) await l.clock.advance(30_000);
    expect(l.ends).toEqual([]);
    expect(l.seen.map((d) => d.cursor)).toEqual(["1"]);
    expect(l.asked.length).toBeGreaterThanOrEqual(11);
    l.poller.stop();
  });
  it("the route is off (404): the loop ends after three answers, whatever the mission does", async () => {
    const l = loop(["off", "off", "off", "off"], { isMissionLive: () => true });
    await flush();
    for (let i = 0; i < 4; i += 1) await l.clock.advance(30_000);
    expect(l.ends).toEqual(["empty"]);
    expect(l.asked).toHaveLength(LIVE_EMPTY_LIMIT);
  });
  it("the mission has ended but the newest snapshot is still a running one: three answers with no news end the loop (no endless polling)", async () => {
    const l = loop([data("5"), unchanged("5"), unchanged("5"), unchanged("5"), unchanged("5")], { isMissionLive: () => false });
    await flush();
    for (let i = 0; i < 5; i += 1) await l.clock.advance(30_000);
    expect(l.ends).toEqual(["empty"]);
    expect(l.asked).toHaveLength(1 + LIVE_EMPTY_LIMIT);
    expect(l.seen.map((d) => d.cursor)).toEqual(["5"]); // the rows already shown stay
  });
  it("REVIEW FIX: after that end the sheet shown stays usable: a page or sheet turn is ONE ask, nothing loops", async () => {
    const l = loop([data("5"), unchanged("5"), unchanged("5"), unchanged("5"), data("5", false, 50)], { isMissionLive: () => false });
    await flush();
    for (let i = 0; i < 4; i += 1) await l.clock.advance(30_000);
    expect(l.ends).toEqual(["empty"]);
    l.poller.setWindow({ offset: 50 });
    await flush();
    expect(l.asked.at(-1)).toEqual({ cursor: null, offset: 50, sheet: null });
    expect(l.seen.at(-1)!.window.offset).toBe(50);
    await l.clock.advance(600_000);
    expect(l.asked).toHaveLength(1 + LIVE_EMPTY_LIMIT + 1);
  });
  it("REVIEW FIX: failed asks for a mission that has ended are counted: a route that keeps failing is not asked forever", async () => {
    const l = loop([data("5"), null, null, null, null, null], { isMissionLive: () => false });
    await flush();
    for (let i = 0; i < 6; i += 1) await l.clock.advance(30_000);
    expect(l.ends).toEqual(["empty"]);
    expect(l.asked).toHaveLength(1 + LIVE_EMPTY_LIMIT);
  });
  it("a page that comes back starts from the data it held: the first ask carries its cursor and window, so «nothing changed» keeps it", async () => {
    const l = loop([unchanged("7"), data("8", false, 50)], { start: { cursor: "7", window: { sheet: "comments", offset: 50 } } });
    await flush();
    expect(l.asked[0]).toEqual({ cursor: "7", offset: 50, sheet: "comments" });
    expect(l.seen).toEqual([]);
    await l.clock.advance(10_000);
    expect(l.seen.map((d) => d.cursor)).toEqual(["8"]);
    l.poller.stop();
  });
});

describe("one answer of the route, as the browser reads it", () => {
  const res = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  it("404 is «off»; any other failure is a passing one; a good answer is passed on without its envelope", async () => {
    expect(await readLiveAnswer(res(404, { success: false, error: "not_found" }))).toBe("off");
    expect(await readLiveAnswer(res(500, { success: false }))).toBeNull();
    expect(await readLiveAnswer(res(502, null))).toBeNull();
    expect(await readLiveAnswer(res(401, { success: false }))).toBeNull();
    expect(await readLiveAnswer(res(200, { success: false }))).toBeNull();
    expect(await readLiveAnswer({ ok: true, status: 200, json: async () => { throw new Error("bad json"); } })).toBeNull();
    expect(await readLiveAnswer(res(200, { success: true, ...waiting }))).toEqual(waiting);
  });
  it("before: three 5xx answers in a row ended the loop for good (the old browser code mapped every failure to «no snapshot»)", () => {
    const hook = readFileSync("src/hooks/useLiveSheet.ts", "utf8");
    expect(hook).not.toContain("if (!res.ok) return { changed: false, cursor: null, retryAfterMs: 30_000, empty: true };");
    expect(hook).toContain('if (res.status === 404) return "off";');
  });
});

describe("the worker's lifecycle line: the done snapshot (written after the file and the settlement) says the file is ready; a running one never does", () => {
  it("done (the real M12 rows): the last line is «الملف جاهز للتنزيل.» at the moment it was built, after the work's own lines", async () => {
    const d = await liveAnswer({ sheet: null, offset: 0, limit: 5 }, { status: "done", nowMs: Date.parse("2026-11-06T08:02:00Z") });
    expect(d.workLog.map((l) => l.code)).toEqual(["items_saved", "file_ready"]);
    expect(d.workLog.at(-1)?.timeAr).toBe("١٠:٠٢");
    expect(d.retryAfterMs).toBeNull();
  });
  it("an unknown code makes no line at all (the whitelist)", () => {
    expect(workLogLine({ code: "provider_called" as never, at: 0 })).toBeNull();
  });
  it("running: no «file ready» line", async () => {
    const d = await liveAnswer({ sheet: null, offset: 0, limit: 5 });
    expect(d.workLog.some((l) => l.code === "file_ready")).toBe(false);
  });
});

describe("the panel's states (the handoff «Diger live sheet»: one status line under the sheet replaces the «دفتر شغل» box)", () => {
  it("before the first snapshot: the grid's skeleton and «بانتظار أول النتائج», no number, no row", () => {
    const html = renderToStaticMarkup(createElement(LiveSheetView, { data: LIVE_EMPTY_DATA }));
    expect(html).toContain(LIVE_STATUS_WAITING_AR);
    expect(html).toContain("بانتظار أول النتائج");
    expect(html).not.toMatch(/[٠-٩]/);
    expect(html).toContain('data-testid="live-grid-skeleton"');
    expect(html).not.toContain('data-testid="live-grid-row"');
  });
  it("rows: the newest work-log line is the status line, under the grid, with its Cairo time", async () => {
    const d = await liveAnswer({ sheet: null, offset: 0, limit: 10 });
    const html = renderToStaticMarkup(createElement(LiveSheetView, { data: d }));
    expect(html.indexOf('data-testid="live-grid-scroll"')).toBeLessThan(html.indexOf('data-testid="live-status"'));
    expect(html).toContain(d.workLog.at(-1)!.textAr);
    expect(html).toContain(d.workLog.at(-1)!.timeAr);
    expect(html).not.toContain(LIVE_STATUS_DONE_AR);
    expect(html).not.toContain(LIVE_STATUS_RECONNECT_AR);
  });
  it("done: the status line says these are the rows of the file (the equality contract), never that they arrived one by one", async () => {
    const d = { ...(await liveAnswer({ sheet: null, offset: 0, limit: 10 })), status: "done" as const, retryAfterMs: null };
    const html = renderToStaticMarkup(createElement(LiveSheetView, { data: d }));
    expect(html).toContain(LIVE_STATUS_DONE_AR);
    expect(html).toContain(LIVE_FINAL_TITLE_AR);
    expect(LIVE_STATUS_DONE_AR).not.toMatch(/تباعًا|واحد(ًا)? تلو|أولًا بأول/);
  });
  it("a failed ask: the rows stay, with one line saying it reconnects", async () => {
    const d = await liveAnswer({ sheet: "videos", offset: 0, limit: 10 });
    const html = renderToStaticMarkup(createElement(LiveSheetView, { data: d, reach: "failing" }));
    expect(html).toContain(LIVE_STATUS_RECONNECT_AR);
    expect((html.match(/data-testid="live-grid-row"/g) ?? []).length).toBe(d.window.rows.length);
  });
});

describe("in the conversation", () => {
  it("the live sheet goes under the LAST card of each mission only (one sheet, one loop per mission)", () => {
    const ids = lastMissionMessageIds([{ id: "u1" }, { id: "a1", agentMissionId: "msn_1" }, { id: "u2" }, { id: "a2", agentMissionId: "msn_1" }, { id: "a3", agentMissionId: "msn_2" }]);
    expect([...ids].sort()).toEqual(["a2", "a3"]);
    const list = [{ id: "a1", agentMissionId: "msn_1" }];
    expect(lastMissionMessageIds(list)).toBe(lastMissionMessageIds(list)); // once per message list
  });
  it("the chat card asks for the live sheet only (never the Ask card), and the card shows it from the approval on, while the server says the flag is on", () => {
    const chat = readFileSync("src/app/dashboard/chat/page.tsx", "utf8");
    expect(chat).toContain("<AgentMissionCard missionId={m.agentMissionId} liveSheet={lastMissionMessageIds(messages).has(m.id)}");
    expect(chat).not.toMatch(/<AgentMissionCard[^>]*\bstage2\b/);
    const card = readFileSync("src/components/mission/AgentMissionCard.tsx", "utf8");
    expect(card).toContain("askCard={stage2 ? answer?.askCard ?? null : null}");
    expect(card).toContain('(v.phase === "plan" && approvedHere)');
    expect(card).toContain("missionLive={!ended}");
  });
});

describe("every new fixed text passes the customer-text rules (Arabic, no Latin, no provider, no id, no emoji)", () => {
  it("labels and sentences", () => {
    for (const t of [LIVE_FINAL_TITLE_AR, LIVE_GRID_TITLE_AR, LIVE_PROGRESS_LABEL_AR, LIVE_SHEETS_LABEL_AR, LIVE_HIDE_AR, LIVE_EMPTY_VALUE_AR, LIVE_PHONE_EMPTY_AR, LIVE_ROW_NUMBER_LABEL_AR, LIVE_PREV_ROW_AR, LIVE_NEXT_ROW_AR, LIVE_CLOSE_AR]) {
      expect(checkCustomerLabel(t).issues, t).toEqual([]);
    }
    for (const t of [agoAr(12_000), agoAr(200_000), counterPartsAr(0, 120).rest, counterPartsAr(0, null).rest, counterPartsAr(12, null).rest, showSheetAr(80), "نتائج جديدة ↓ (١٢)", "رقم ١٢ · المنشورات"]) expect(checkCustomerText(t).issues, t).toEqual([]);
    const sentences = [LIVE_STATUS_WAITING_AR, LIVE_STATUS_QUIET_AR, LIVE_STATUS_RECONNECT_AR, LIVE_STATUS_DONE_AR, LIVE_STATUS_WORKING_AR, LIVE_CUT_NOTE_AR];
    for (const t of sentences) expect(checkCustomerText(t).issues, t).toEqual([]);
    for (const t of [...sentences, LIVE_FINAL_TITLE_AR, LIVE_EMPTY_VALUE_AR]) expect(t).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});
