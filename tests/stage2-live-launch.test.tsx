import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { liveAnswer } from "./helpers/stage2Live";
import { LIVE_EMPTY_LIMIT, startLivePolling, type LiveData, type LiveFetchResult } from "../src/lib/agentMission/stage2/livePoller";
import type { LivePollResponse } from "../src/lib/agentMission/stage2/liveSheet";
import { readLiveAnswer } from "../src/hooks/useLiveSheet";
import { cellTextOf, LIVE_FINAL_TITLE_AR, LIVE_GRID_TITLE_AR, LIVE_PROGRESS_LABEL_AR, LIVE_SHEETS_LABEL_AR, LiveSheetGrid, nextOffsetOf } from "../src/components/mission/LiveSheetGrid";
import { cardFieldsOf, fieldsOf, LIVE_ALL_FIELDS_AR, LIVE_FINAL_COUNTER_TITLE_AR, LiveSheetCards } from "../src/components/mission/LiveSheetCards";
import { LIVE_WORK_LOG_HISTORY_AR, LIVE_WORK_LOG_TITLE_AR, LiveWorkLog } from "../src/components/mission/LiveWorkLog";
import { LIVE_FINAL_AR, LIVE_RECONNECT_AR, LIVE_WAITING_AR, LiveSheetView, LiveSheetWaiting } from "../src/components/mission/LiveSheetPanel";
import { lastMissionMessageIds } from "../src/lib/agentMission/stage2/livePlacement";
import { workLogLine, type WorkLogLine } from "../src/lib/agentMission/stage2/workLog";
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

describe("the desktop grid: progress, title and the rows the route sent", () => {
  it("the counter and its bar sit above the grid; the bar is delivered of promised", async () => {
    const d = await liveAnswer({ sheet: null, offset: 0, limit: 50 });
    const html = renderToStaticMarkup(createElement(LiveSheetGrid, { data: d }));
    expect(html).toContain(`data-testid="live-grid-counter">${d.counterAr}<`);
    expect(html).toContain(LIVE_GRID_TITLE_AR);
    expect(html).toContain(`aria-label="${LIVE_PROGRESS_LABEL_AR}"`);
    expect(html).toContain(`aria-valuemax="${d.promised}"`);
  });
  it("no promised total: the counter shows only the number and NO bar is drawn (no invented percentage)", async () => {
    const d = { ...(await liveAnswer({ sheet: null, offset: 0, limit: 5 })), promised: null, counterAr: "١٢" };
    const html = renderToStaticMarkup(createElement(LiveSheetGrid, { data: d }));
    expect(html).not.toContain('role="progressbar"');
    expect(html).toContain('data-testid="live-grid-counter">١٢<');
  });
  it("the done snapshot is titled as the final result", async () => {
    const d = { ...(await liveAnswer({ sheet: null, offset: 0, limit: 5 })), status: "done" as const, retryAfterMs: null };
    const html = renderToStaticMarkup(createElement(LiveSheetGrid, { data: d }));
    expect(html).toContain(LIVE_FINAL_TITLE_AR);
    expect(html).not.toContain(LIVE_GRID_TITLE_AR);
  });
  it("every rendered row is the stored row: its id and every cell's text, in the window's order, under the file's headers in the file's order", async () => {
    const d = await liveAnswer({ sheet: "comments", offset: 0, limit: 50 });
    const html = renderToStaticMarkup(createElement(LiveSheetGrid, { data: d }));
    const sheet = d.sheets.find((s) => s.stageKey === "comments")!;
    const head = html.slice(html.indexOf('data-testid="live-grid-head"'), html.indexOf("</thead>"));
    expect([...head.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => m[1])).toEqual(sheet.headers);
    const rows = html.split('data-testid="live-grid-row"').slice(1).map((r) => [...r.split("</tr>")[0].matchAll(/<td[^>]*>(?:<a[^>]*>)?([^<]*)/g)].map((m) => m[1]));
    expect(rows).toHaveLength(d.window.rows.length);
    const unescape = (s: string) => s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
    d.window.rows.forEach((r, i) => {
      expect(rows[i].map(unescape)).toEqual([...r.cells.map(cellTextOf), r.id, ...(r.parentId !== null ? [r.parentId] : [])]);
    });
    // the comments sheet is the file's thread sheet: the comments and, under each, its replies (both stored files of the real mission)
    const stored = ["comments", "comments_replies"].flatMap((k) => JSON.parse(readFileSync(`tests/fixtures/live/missions/msn_5851abc92a1e6645a9cd/rows/${k}.json`, "utf8")) as Array<{ id: string }>);
    const storedIds = new Set(stored.map((r) => String(r.id)));
    for (const r of d.window.rows) expect(storedIds.has(r.id)).toBe(true);
  });
  it("a window shortened to the size limit: the next page starts right after the last row shown (none skipped)", () => {
    expect(nextOffsetOf(0, 50)).toBe(50);
    expect(nextOffsetOf(0, 12)).toBe(12);
    expect(nextOffsetOf(100, 7)).toBe(107);
  });
});

describe("the phone: tabs, counter, cards, and every field one tap away", () => {
  it("the file's sheets are tabs on a phone too", async () => {
    const d = await liveAnswer({ sheet: "comments", offset: 0, limit: 10 });
    expect(d.sheets.length).toBeGreaterThan(1);
    const html = renderToStaticMarkup(createElement(LiveSheetCards, { data: d }));
    expect(html).toContain(`aria-label="${LIVE_SHEETS_LABEL_AR}"`);
    for (const s of d.sheets) expect(html).toContain(s.nameAr);
  });
  it("each card leads with three fields and opens «كل الحقول» with the rest: together exactly the row's filled fields and identifiers, in the file's order, none twice", async () => {
    const d = await liveAnswer({ sheet: "comments", offset: 0, limit: 20 });
    const sheet = d.sheets.find((s) => s.stageKey === d.window.stageKey)!;
    for (const r of d.window.rows) {
      const { lead, rest } = cardFieldsOf(r, sheet.headers);
      const { file, ids } = fieldsOf(r, sheet.headers);
      expect(lead.length).toBeLessThanOrEqual(3);
      expect([...lead, ...rest].length).toBe(file.length + ids.length);
      expect(new Set([...lead, ...rest]).size).toBe(file.length + ids.length);
      expect(file.length).toBe(r.cells.filter((c) => c.k !== "empty").length);
      expect(ids.map((f) => f.c.v)).toEqual([r.id, ...(r.parentId ? [r.parentId] : [])]);
    }
    const html = renderToStaticMarkup(createElement(LiveSheetCards, { data: d }));
    expect((html.match(/data-testid="live-card-more"/g) ?? []).length).toBe(d.window.rows.length);
    expect(html).toContain(LIVE_ALL_FIELDS_AR);
  });
  it("the file's own row number «م» never takes a lead place", () => {
    const row = { id: "a1", parentId: null, cells: [{ k: "number" as const, v: "1" }, { k: "text" as const, v: "x" }, { k: "text" as const, v: "y" }, { k: "text" as const, v: "z" }] };
    const { lead, rest } = cardFieldsOf(row, ["م", "أ", "ب", "ج", "المعرّف"]);
    expect(lead.map((f) => f.h)).toEqual(["أ", "ب", "ج"]);
    expect(rest.map((f) => f.h)).toEqual(["م", "المعرّف"]);
  });
  it("long links and words wrap anywhere; the counter says «final» once done", async () => {
    const d = { ...(await liveAnswer({ sheet: "videos", offset: 0, limit: 5 })), status: "done" as const, retryAfterMs: null };
    const html = renderToStaticMarkup(createElement(LiveSheetCards, { data: d }));
    expect(html).toContain("[overflow-wrap:anywhere]");
    expect(html).toContain(LIVE_FINAL_COUNTER_TITLE_AR);
  });
});

describe("«دفتر شغل»: ONE line, the newest; the rest under «آخر التحديثات»", () => {
  const line = (code: string, at: number, extra: Record<string, unknown> = {}): WorkLogLine => workLogLine({ code: code as never, at, ...extra })!;
  it("the newest event is the line; older ones open below, newest first", () => {
    const lines = [line("items_saved", Date.parse("2026-11-06T08:00:00Z"), { n: 2, total: 2, promised: 5, noun: "videos" }), line("items_saved", Date.parse("2026-11-06T08:01:00Z"), { n: 3, total: 5, promised: 5, noun: "videos" }), line("file_ready", Date.parse("2026-11-06T08:02:00Z"))];
    const html = renderToStaticMarkup(createElement(LiveWorkLog, { lines }));
    const latest = html.slice(html.indexOf('data-testid="live-work-latest"'), html.indexOf("</p>"));
    expect(latest).toContain("الملف جاهز للتنزيل.");
    expect(latest).toContain("١٠:٠٢");
    expect(latest).not.toContain("أضفنا");
    const history = html.slice(html.indexOf('data-testid="live-work-history"'));
    expect(history).toContain(LIVE_WORK_LOG_HISTORY_AR);
    expect(history.indexOf("١٠:٠١")).toBeLessThan(history.indexOf("١٠:٠٠"));
  });
  it("one line only: no history to open", () => {
    const html = renderToStaticMarkup(createElement(LiveWorkLog, { lines: [line("file_ready", 0)] }));
    expect(html).not.toContain("live-work-history");
  });
  it("an unknown code makes no line at all (the whitelist)", () => {
    expect(workLogLine({ code: "provider_called" as never, at: 0 })).toBeNull();
  });
});

describe("the worker's lifecycle line: the done snapshot (written after the file and the settlement) says the file is ready; a running one never does", () => {
  it("done (the real M12 rows): the last line is «الملف جاهز للتنزيل.» at the moment it was built, after the work's own lines", async () => {
    const d = await liveAnswer({ sheet: null, offset: 0, limit: 5 }, { status: "done", nowMs: Date.parse("2026-11-06T08:02:00Z") });
    expect(d.workLog.map((l) => l.code)).toEqual(["items_saved", "file_ready"]);
    expect(d.workLog.at(-1)?.timeAr).toBe("١٠:٠٢");
    expect(d.retryAfterMs).toBeNull();
  });
  it("running: no «file ready» line", async () => {
    const d = await liveAnswer({ sheet: null, offset: 0, limit: 5 });
    expect(d.workLog.some((l) => l.code === "file_ready")).toBe(false);
  });
});

describe("the panel's states", () => {
  it("before the first snapshot: one line, no table and no number", () => {
    const html = renderToStaticMarkup(createElement(LiveSheetWaiting));
    expect(html).toContain(LIVE_WAITING_AR);
    expect(html).not.toMatch(/[٠-٩]/);
    expect(html).not.toContain("<table");
  });
  it("rows: the work-log line first, then the grid (desktop) and the cards (phone)", async () => {
    const d = await liveAnswer({ sheet: null, offset: 0, limit: 10 });
    const html = renderToStaticMarkup(createElement(LiveSheetView, { data: d }));
    expect(html.indexOf('data-testid="live-work-log"')).toBeLessThan(html.indexOf('data-testid="live-grid"'));
    expect(html).not.toContain(LIVE_FINAL_AR);
    expect(html).not.toContain(LIVE_RECONNECT_AR);
  });
  it("done: the final line says these are the rows of the file (the equality contract), never that they arrived one by one", async () => {
    const d = { ...(await liveAnswer({ sheet: null, offset: 0, limit: 10 })), status: "done" as const, retryAfterMs: null };
    const html = renderToStaticMarkup(createElement(LiveSheetView, { data: d }));
    expect(html).toContain(LIVE_FINAL_AR);
    expect(LIVE_FINAL_AR).not.toMatch(/تباعًا|واحد(ًا)? تلو|أولًا بأول/);
  });
  it("a failed ask: the last data stays, with one line saying it will try again", async () => {
    const d = await liveAnswer({ sheet: null, offset: 0, limit: 10 });
    const html = renderToStaticMarkup(createElement(LiveSheetView, { data: d, reach: "failing" }));
    expect(html).toContain(LIVE_RECONNECT_AR);
    expect((html.match(/data-testid="live-grid-row"/g) ?? []).length).toBe(d.window.rows.length);
  });
});

describe("in the conversation", () => {
  it("the live sheet goes under the LAST card of each mission only (one sheet, one loop per mission)", () => {
    const ids = lastMissionMessageIds([{ id: "u1" }, { id: "a1", agentMissionId: "msn_1" }, { id: "u2" }, { id: "a2", agentMissionId: "msn_1" }, { id: "a3", agentMissionId: "msn_2" }]);
    expect([...ids].sort()).toEqual(["a2", "a3"]);
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
    for (const t of [LIVE_FINAL_TITLE_AR, LIVE_PROGRESS_LABEL_AR, LIVE_SHEETS_LABEL_AR, LIVE_ALL_FIELDS_AR, LIVE_FINAL_COUNTER_TITLE_AR, LIVE_WORK_LOG_HISTORY_AR, LIVE_WORK_LOG_TITLE_AR]) {
      expect(checkCustomerLabel(t).issues, t).toEqual([]);
    }
    for (const t of [LIVE_WAITING_AR, LIVE_FINAL_AR, LIVE_RECONNECT_AR]) expect(checkCustomerText(t).issues, t).toEqual([]);
    for (const t of [LIVE_WAITING_AR, LIVE_FINAL_AR, LIVE_RECONNECT_AR, LIVE_FINAL_TITLE_AR, LIVE_ALL_FIELDS_AR]) expect(t).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});
