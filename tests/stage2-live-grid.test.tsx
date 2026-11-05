import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { liveAnswer } from "./helpers/stage2Live";
import { LIVE_GRID_TITLE_AR, LIVE_NEXT_AR, LIVE_PREV_AR, LiveSheetGrid, cellTextOf, pageLineAr } from "../src/components/mission/LiveSheetGrid";
import { checkCustomerLabel, checkCustomerText } from "../src/lib/agentMission/text";

/** STAGE 2 S9 (docs/STAGE-2.md): the live sheet on a desktop, drawn from a REAL snapshot (stored rows of M12, the worker's builder, the route's contract): the file's sheets and headers, frozen header, pages of 50. */
describe("the desktop grid (S9)", () => {
  it("the file's sheets as tabs, the file's headers in a frozen header row, right to left, a page of 50 rows", async () => {
    const data = await liveAnswer({ sheet: null, offset: 0, limit: 50 });
    const html = renderToStaticMarkup(createElement(LiveSheetGrid, { data }));
    expect(html).toContain('dir="rtl"');
    expect(html).toContain(LIVE_GRID_TITLE_AR);
    for (const s of data.sheets) expect(html).toContain(s.nameAr);
    for (const h of data.sheets[0].headers) expect(html).toContain(`>${h}</th>`);
    expect(html).toMatch(/<thead class="[^"]*\bsticky\b[^"]*\btop-0\b/);
    expect((html.match(/data-testid="live-grid-row"/g) ?? []).length).toBe(data.window.rows.length);
    expect(html).toContain(`>${pageLineAr(0, data.window.rows.length, data.sheets[0].total)}<`);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>السابق<\/button>/);
  });
  it("the second sheet's second page: rows 51 to 100", async () => {
    const data = await liveAnswer({ sheet: "comments", offset: 50, limit: 50 });
    const html = renderToStaticMarkup(createElement(LiveSheetGrid, { data }));
    expect(data.window.rows).toHaveLength(50);
    expect(html).toContain(`>${pageLineAr(50, 50, data.sheets.find((s) => s.stageKey === "comments")!.total)}<`);
  });
  it("a cell shows the file's value: a date its Cairo text, a number in Arabic-Indic digits, a link as a link", () => {
    expect(cellTextOf({ k: "date", v: "2026-10-05T10:00:00.000Z", d: "2026-10-05 10:00" })).toBe("2026-10-05 10:00");
    expect(cellTextOf({ k: "number", v: "1250" })).toBe("١٢٥٠");
    expect(cellTextOf({ k: "text", v: "نص" })).toBe("نص");
    expect(pageLineAr(0, 50, 120)).toBe("١–٥٠ من ١٢٠");
    expect(pageLineAr(0, 0, 0)).toBe("٠");
  });
});

describe("its words", () => {
  it("pass the customer-text rules", () => {
    for (const t of [LIVE_GRID_TITLE_AR, LIVE_PREV_AR, LIVE_NEXT_AR]) { expect(checkCustomerText(t).issues, t).toEqual([]); expect(checkCustomerLabel(t).issues, t).toEqual([]); }
    expect(checkCustomerText(pageLineAr(50, 50, 300)).issues).toEqual([]);
  });
});
