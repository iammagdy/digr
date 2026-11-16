import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { liveAnswer } from "./helpers/stage2Live";
import { LiveSheetGrid } from "../src/components/mission/LiveSheetGrid";
import {
  COL_WIDTH, LIVE_FINAL_TITLE_AR, LIVE_GRID_TITLE_AR, LIVE_OPEN_CHIP_AR, LIVE_PROGRESS_LABEL_AR, LIVE_SHEETS_LABEL_AR, LIVE_STATUS_DONE_AR, LIVE_STATUS_QUIET_AR, LIVE_STATUS_RECONNECT_AR, LIVE_STATUS_WAITING_AR,
  QUIET_AFTER_MS, REVEAL_GAP_MS, REVEAL_MIN_GAP_MS, cellTextOf, colKindOf, counterPartsAr, displayCellsOf, revealGapMs, rowPartsOf, showSheetAr, statusLineOf,
} from "../src/lib/agentMission/stage2/liveSheetView";
import { counterAr } from "../src/lib/agentMission/stage2/liveSheet";
import { checkCustomerLabel, checkCustomerText } from "../src/lib/agentMission/text";

/**
 * THE LIVE SHEET ON A DESKTOP (the Claude Design handoff «Diger live sheet», 16 Nov 2026), drawn from a REAL snapshot (stored rows of M12, the worker's builder, the route's contract): a
 * spreadsheet with a frozen header row and row-number column, one line per cell, links as a chip, the rows of the route's window and nothing else, the counter in the toolbar, the status
 * line and the Excel-like tabs at the bottom. No page buttons: the grid follows the newest rows and asks for the rows around what is scrolled to.
 */
const render = (props: Parameters<typeof LiveSheetGrid>[0]) => renderToStaticMarkup(createElement(LiveSheetGrid, props));
const unescape = (s: string) => s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

describe("the desktop sheet", () => {
  it("a spreadsheet: the file's headers in order in a frozen header row, a frozen row-number column, right to left, no page buttons", async () => {
    const data = await liveAnswer({ sheet: "comments", offset: 0, limit: 50 });
    const sheet = data.sheets.find((s) => s.stageKey === "comments")!;
    const html = render({ data });
    expect(html).toContain('dir="rtl"');
    expect(html).toContain('role="grid"');
    expect(html).toContain(`aria-rowcount="${sheet.total + 1}"`);
    expect([...html.matchAll(/data-testid="live-grid-header">([^<]*)</g)].map((m) => m[1])).toEqual(sheet.headers);
    expect(html).toMatch(/role="row" aria-rowindex="1" class="sticky top-0/);
    expect(html).toMatch(/role="rowheader" class="sticky start-0/);
    expect(html).not.toMatch(/>(السابق|التالي|عرض المزيد)</);
  });
  it("every drawn row is the stored row: its number, and every cell (the file's cells, then its ids) in the file's order; a link is a «فتح ↗» chip, never its long address", async () => {
    const data = await liveAnswer({ sheet: "comments", offset: 0, limit: 50 });
    const sheet = data.sheets.find((s) => s.stageKey === "comments")!;
    const html = render({ data });
    const drawn = html.split('data-testid="live-grid-row"').slice(1);
    expect(drawn.length).toBe(30); // 107 rows: the visible ten and twenty more are in the page (virtualised)
    drawn.forEach((chunk, i) => {
      const r = data.window.rows[i];
      expect(chunk).toMatch(new RegExp(`role="rowheader"[^>]*>${i === 0 ? "١" : ""}`));
      const titles = [...chunk.matchAll(/role="gridcell"([^>]*)>/g)].map((m) => unescape(/title="([^"]*)"/.exec(m[1])?.[1] ?? ""));
      expect(titles).toEqual(displayCellsOf(r, sheet.headers).map((c) => (c.k === "link" ? c.v : cellTextOf(c))));
      for (const c of r.cells.filter((x) => x.k === "link")) expect(chunk).not.toContain(`>${c.v}<`);
    });
    expect(html).toContain(`>${LIVE_OPEN_CHIP_AR}</a>`);
    expect(html).toContain('target="_blank" rel="noopener noreferrer"');
  });
  it("one line per cell with an ellipsis; numbers centred in Arabic-Indic digits; dates their Cairo text, left to right; ids in a quiet monospace", async () => {
    const data = await liveAnswer({ sheet: "videos", offset: 0, limit: 50 });
    const html = render({ data });
    expect(html).toContain("truncate");
    expect(html).toContain(">٢٠٬٦٧٧<");
    expect(html).toContain('dir="ltr" class="block min-w-0 max-w-full truncate text-right [font-variant-numeric:tabular-nums] text-[12.5px] text-ink2 ">2026-07-18 17:48<');
    expect(html).toMatch(/font-mono[^"]*">7663879872137252114</);
  });
  it("the toolbar: the title, the counter (over the plan said in words, F-1) and the fold; the bar of delivered to promised", async () => {
    const data = await liveAnswer({ sheet: null, offset: 0, limit: 50 });
    const html = render({ data });
    expect(html).toContain(LIVE_GRID_TITLE_AR);
    expect(html).toContain(`aria-label="${data.counterAr}"`);
    expect(data.counterAr).toBe(counterAr(data.delivered, data.promised));
    expect(html).toContain("(أكثر من التقدير البالغ ٧٠)");
    expect(html).not.toMatch(/١٠٩<\/span><span[^>]*>من ٧٠/);
    expect(html).toContain(`aria-label="${LIVE_PROGRESS_LABEL_AR}"`);
    expect(html).toContain('aria-valuenow="70"');
    expect(html).toContain('data-testid="live-fold"');
  });
  it("the file's sheets are tabs at the bottom, each with its count", async () => {
    const data = await liveAnswer({ sheet: null, offset: 0, limit: 50 });
    const html = render({ data });
    expect(html).toContain(`aria-label="${LIVE_SHEETS_LABEL_AR}"`);
    for (const s of data.sheets) expect(html).toMatch(new RegExp(`<span>${s.nameAr}</span><span[^>]*>[٠-٩٬]+</span>`));
    expect(html.indexOf('data-testid="live-tabs"')).toBeGreaterThan(html.indexOf('data-testid="live-grid-scroll"'));
  });
  it("no promised total: the number and «حتى الآن», a hairline and no bar (no invented percentage)", async () => {
    const data = { ...(await liveAnswer({ sheet: null, offset: 0, limit: 5 })), promised: null, delivered: 12, counterAr: "١٢" };
    const html = render({ data });
    expect(html).not.toContain('role="progressbar"');
    expect(html).toContain(">١٢</span>");
    expect(html).toContain("حتى الآن");
  });
  it("nothing saved yet: the real headers, skeleton rows, and «بانتظار أول النتائج · المطلوب ٧٠», never a lone «٠»", async () => {
    const base = await liveAnswer({ sheet: null, offset: 0, limit: 5 });
    const data = { ...base, sheets: [], window: { stageKey: "", offset: 0, rows: [] }, delivered: 0, promised: 70, counterAr: "٠ من ٧٠" };
    const html = render({ data });
    expect(html).toContain("بانتظار أول النتائج · المطلوب ٧٠");
    expect(html).not.toContain(">٠<");
    expect(html).toContain('aria-valuenow="0"');
    expect((html.match(/data-testid="live-grid-skeleton"/g) ?? []).length).toBe(5);
    expect(html).toContain(LIVE_STATUS_WAITING_AR);
  });
  it("done: «النتائج النهائية», and the status line says these are the rows of the file", async () => {
    const data = { ...(await liveAnswer({ sheet: null, offset: 0, limit: 5 })), status: "done" as const, retryAfterMs: null };
    const html = render({ data });
    expect(html).toContain(LIVE_FINAL_TITLE_AR);
    expect(html).not.toContain(LIVE_GRID_TITLE_AR);
    expect(html).toContain(LIVE_STATUS_DONE_AR);
    expect(html).toContain('data-tone="done"');
  });
  it("a failed ask: the rows stay; the status line, in gold, says it reconnects", async () => {
    const data = await liveAnswer({ sheet: "videos", offset: 0, limit: 5 });
    const html = render({ data, reach: "failing" });
    expect(html).toContain(LIVE_STATUS_RECONNECT_AR);
    expect(html).toContain('data-tone="retry"');
    expect((html.match(/data-testid="live-grid-row"/g) ?? []).length).toBe(2);
  });
});

describe("the drawing rules (pure)", () => {
  it("column kinds: ids by their header, then the first filled cell, the text's length and script; with no row yet, the header's name", () => {
    expect(colKindOf("المعرّف", [{ k: "text", v: "123" }])).toBe("id");
    expect(colKindOf("معرّف الأصل", [])).toBe("id");
    expect(colKindOf("الإعجابات", [{ k: "empty", v: "" }, { k: "number", v: "5" }])).toBe("number");
    expect(colKindOf("x", [{ k: "date", v: "2026-01-01T00:00:00Z", d: "2026-01-01 02:00" }])).toBe("date");
    expect(colKindOf("x", [{ k: "link", v: "https://a.b" }])).toBe("link");
    expect(colKindOf("x", [{ k: "text", v: "ن".repeat(60) }])).toBe("long");
    expect(colKindOf("x", [{ k: "text", v: "SaudiMOH" }])).toBe("latin");
    expect(colKindOf("x", [{ k: "text", v: "الرياض" }])).toBe("short");
    expect(colKindOf("الموقع", [{ k: "empty", v: "" }])).toBe("emptycol");
    expect(colKindOf("النص", [])).toBe("long");
    expect(colKindOf("الرابط", [])).toBe("link");
    expect(COL_WIDTH.long).toBe(300);
    expect(COL_WIDTH.link).toBe(72);
  });
  it("the counter: the number apart from its words; no number before the first row; over the plan in words", () => {
    expect(counterPartsAr(80, 120)).toEqual({ num: "٨٠", rest: "من ١٢٠", label: "٨٠ من ١٢٠" });
    expect(counterPartsAr(0, 120)).toEqual({ num: null, rest: "بانتظار أول النتائج · المطلوب ١٢٠", label: "بانتظار أول النتائج · المطلوب ١٢٠" });
    expect(counterPartsAr(0, null).num).toBeNull();
    expect(counterPartsAr(12, null).rest).toBe("حتى الآن");
    expect(counterPartsAr(109, 70).label).toBe(counterAr(109, 70));
    expect(counterPartsAr(1200, 2000).num).toBe("١٬٢٠٠");
  });
  it("the status line: reconnecting, done, waiting, quiet after 45 s with no new row, else the newest work-log line and how long ago the last row landed", () => {
    const wl = [{ code: "page_read" as const, at: 1, timeAr: "١٣:٣٢", textAr: "قرأنا صفحتين من المصدر حتى الآن." }, { code: "page_read" as const, at: 2, timeAr: "١٣:٣٤", textAr: "قرأنا ٤ صفحات من المصدر حتى الآن." }];
    const base = { status: "running" as const, failing: false, shown: 10, pending: 0, workLog: wl, lastRowAt: 1000, sinceMs: 0, nowMs: 3000 };
    expect(statusLineOf(base)).toEqual({ tone: "live", timeAr: "١٣:٣٤", textAr: "قرأنا ٤ صفحات من المصدر حتى الآن.", agoAr: "الآن" });
    expect(statusLineOf({ ...base, nowMs: 13_000 }).agoAr).toBe("آخر إضافة قبل ١٢ ث");
    expect(statusLineOf({ ...base, nowMs: 1000 + QUIET_AFTER_MS + 1 }).textAr).toBe(LIVE_STATUS_QUIET_AR);
    expect(statusLineOf({ ...base, nowMs: 1000 + QUIET_AFTER_MS + 1, pending: 3 }).tone).toBe("live"); // rows still landing: not quiet
    expect(statusLineOf({ ...base, failing: true }).textAr).toBe(LIVE_STATUS_RECONNECT_AR);
    expect(statusLineOf({ ...base, status: "done" }).textAr).toBe(LIVE_STATUS_DONE_AR);
    expect(statusLineOf({ ...base, status: "done", pending: 2 }).tone).toBe("live"); // the done snapshot's last rows still landing
    expect(statusLineOf({ ...base, shown: 0 }).textAr).toBe(LIVE_STATUS_WAITING_AR);
    expect(statusLineOf({ ...base, lastRowAt: null }).agoAr).toBeNull(); // no row landed on this screen: no «ago» is invented
  });
  it("rows land 420 ms apart, faster when many wait (never under 80 ms)", () => {
    expect(revealGapMs(1)).toBe(REVEAL_GAP_MS);
    expect(revealGapMs(5)).toBe(REVEAL_GAP_MS);
    expect(revealGapMs(20)).toBe(200);
    expect(revealGapMs(500)).toBe(REVEAL_MIN_GAP_MS);
  });
  it("a row's parts (the phone and the detail): the row's own text, at most three numbers, the link, and the rest: together exactly the file's columns, none twice", async () => {
    for (const sheetKey of ["videos", "comments"]) {
      const data = await liveAnswer({ sheet: sheetKey, offset: 0, limit: 20 });
      const sheet = data.sheets.find((s) => s.stageKey === sheetKey)!;
      for (const r of data.window.rows) {
        const cells = displayCellsOf(r, sheet.headers);
        const kinds = sheet.headers.map((h, i) => colKindOf(h, [cells[i]]));
        const p = rowPartsOf(cells, sheet.headers, kinds);
        const all = [p.text?.i, p.link?.i, ...p.stats.map((s) => s.i), ...p.rest.map((x) => x.i)].filter((i): i is number => i !== undefined);
        expect(all.sort((a, b) => a - b)).toEqual(sheet.headers.map((_, i) => i));
        expect(p.stats.length).toBeLessThanOrEqual(3);
        if (sheetKey === "comments") expect(p.text?.h).toBe("نص التعليق");
      }
    }
  });
  it("the fold's words (never «صف»: the customer texts name results, not rows)", () => {
    expect(showSheetAr(80)).toBe("اعرض الجدول (٨٠)");
    expect(showSheetAr(0)).toBe("اعرض الجدول");
    for (const t of [showSheetAr(80), showSheetAr(0), counterPartsAr(0, 120).rest, counterPartsAr(80, 120).label]) { expect(checkCustomerText(t).issues, t).toEqual([]); expect(checkCustomerLabel(t).issues, t).toEqual([]); }
  });
});
