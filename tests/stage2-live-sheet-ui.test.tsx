import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { liveAnswer } from "./helpers/stage2Live";
import { LiveSheetCards } from "../src/components/mission/LiveSheetCards";
import { LIVE_EMPTY_DATA, LIVE_SHEET_BREAKPOINT, LiveSheetView } from "../src/components/mission/LiveSheetPanel";
import { LIVE_PHONE_EMPTY_AR, LIVE_SHEETS_LABEL_AR, cellTextOf } from "../src/lib/agentMission/stage2/liveSheetView";

/**
 * THE LIVE SHEET ON A PHONE (the Claude Design handoff «Diger live sheet», variant «peek»), drawn from a REAL snapshot (stored rows of M12): a card with the counter and its bar, one status
 * line, the sheets as a segmented control, and the NEWEST THREE rows (oldest on top); a tap opens every field of a row in a bottom sheet. The view picks the grid or the card by its own width.
 */
const render = (props: Parameters<typeof LiveSheetCards>[0]) => renderToStaticMarkup(createElement(LiveSheetCards, props));

describe("the phone card", () => {
  it("the newest three rows of the sheet (its tail window), oldest on top, each with its row number and its first two numbers", async () => {
    const data = await liveAnswer({ sheet: "comments", offset: 0, limit: 50, tail: true });
    const sheet = data.sheets.find((s) => s.stageKey === "comments")!;
    expect(data.window.offset).toBe(sheet.total - 50);
    const html = render({ data });
    const cards = html.split('data-testid="live-card"').slice(1);
    expect(cards).toHaveLength(3);
    const last3 = data.window.rows.slice(-3);
    cards.forEach((chunk, k) => {
      const n = sheet.total - 3 + k + 1;
      expect(chunk).toContain(`رقم ${n.toLocaleString("ar-EG", { useGrouping: false })}`);
      expect(chunk).toContain(`>${cellTextOf(last3[k].cells[2]).replace(/&/g, "&amp;")}<`); // «نص التعليق»: the comment's own text leads
    });
    expect(html).toContain("line-clamp-2");
  });
  it("the counter and its bar on top, the sheets as a segmented control, and nothing else to press", async () => {
    const data = await liveAnswer({ sheet: "comments", offset: 0, limit: 50, tail: true });
    const html = render({ data });
    expect(html).toContain(`aria-label="${data.counterAr}"`);
    expect(html).toContain('role="progressbar"');
    expect(html).toContain(`aria-label="${LIVE_SHEETS_LABEL_AR}"`);
    for (const s of data.sheets) expect(html).toContain(s.nameAr);
    expect(html).not.toMatch(/>(عرض المزيد|عرض السابق|كل الحقول)</);
    expect((html.match(/<button/g) ?? []).length).toBe(data.sheets.length + 3); // the tabs and the three rows
  });
  it("no row yet: one quiet line, no number", () => {
    const html = render({ data: { ...LIVE_EMPTY_DATA, promised: 120 } });
    expect(html).toContain(LIVE_PHONE_EMPTY_AR);
    expect(html).toContain("بانتظار أول النتائج · المطلوب ١٢٠");
    expect(html).not.toContain('data-testid="live-card"');
  });
  it("the over-delivery words on the phone too (F-1)", async () => {
    const data = await liveAnswer({ sheet: "comments", offset: 0, limit: 10, tail: true });
    const html = render({ data });
    expect(html).toContain("أكثر من التقدير");
    expect(html).not.toMatch(/١٠٩<\/span><span[^>]*>من ٧٠/);
  });
});

describe("one view, the right drawing for its width", () => {
  it("the grid from 560 px of its own width, the phone card below; measured in the browser (the server draws the grid)", async () => {
    expect(LIVE_SHEET_BREAKPOINT).toBe(560);
    const data = await liveAnswer({ sheet: null, offset: 0, limit: 10 });
    const html = renderToStaticMarkup(createElement(LiveSheetView, { data }));
    expect(html).toContain('data-mode="desktop"');
    expect(html).toContain('data-testid="live-grid"');
    const panel = readFileSync("src/components/mission/LiveSheetPanel.tsx", "utf8");
    expect(panel).toContain('setMode(w >= LIVE_SHEET_BREAKPOINT ? "desktop" : "phone")');
    expect(panel).toContain("new ResizeObserver(measure)");
  });
  it("in the conversation and on the requests page, only when the mission answer says the flag is on", () => {
    const card = readFileSync("src/components/mission/AgentMissionCard.tsx", "utf8");
    expect(card).toContain('const showLive = liveSheet && answer?.liveSheet === true && (v.phase === "running" || v.phase === "done" || v.phase === "partial" || (v.phase === "plan" && approvedHere));');
    expect(card).toContain("stage2 = false, liveSheet = stage2 }");
    const route = readFileSync("src/app/api/missions/[id]/route.ts", "utf8");
    expect(route).toContain('const liveSheet = await stage2FlagForMission(client, "DIGER_STAGE2_LIVE_SHEET", id);');
    expect(readFileSync("src/app/dashboard/requests/[id]/page.tsx", "utf8")).toContain("<AgentMissionCard missionId={missionId} stage2 />");
    expect(readFileSync("src/app/dashboard/chat/page.tsx", "utf8")).toContain("liveSheet={lastMissionMessageIds(messages).has(m.id)}");
  });
});
