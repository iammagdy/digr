import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { liveAnswer } from "./helpers/stage2Live";
import { LIVE_BACK_AR, LIVE_COUNTER_TITLE_AR, LIVE_MORE_AR, LiveSheetCards } from "../src/components/mission/LiveSheetCards";
import { LIVE_WORK_LOG_TITLE_AR, LiveWorkLog } from "../src/components/mission/LiveWorkLog";
import { counterAr } from "../src/lib/agentMission/stage2/liveSheet";
import { LiveSheetView } from "../src/components/mission/LiveSheetPanel";
import { checkCustomerLabel, checkCustomerText } from "../src/lib/agentMission/text";

/** STAGE 2 S10 (docs/STAGE-2.md): the live sheet on a phone (the counter «X من N» and cards) and the work log, drawn from a REAL snapshot (stored rows of M12); shown on the requests page only. */
describe("the phone (S10): the counter «X من N», cards and the next window", () => {
  it("the counter on top, one card per row with at most three filled cells, «عرض المزيد» while rows remain", async () => {
    const data = await liveAnswer({ sheet: "comments", offset: 0, limit: 50 });
    const html = renderToStaticMarkup(createElement(LiveSheetCards, { data }));
    expect(html).toContain(LIVE_COUNTER_TITLE_AR);
    expect(html).toContain(`>${data.counterAr}<`);
    expect(data.counterAr).toBe(counterAr(data.delivered, data.promised)); // the real M12 rows are above the plan's number: the over-delivery wording (F-1)
    expect(data.counterAr).toMatch(/^[٠-٩٬]+ \(أكثر من التقدير البالغ [٠-٩٬]+\)$/);
    expect((html.match(/data-testid="live-card"/g) ?? []).length).toBe(data.window.rows.length);
    for (const card of html.split('data-testid="live-card"').slice(1)) expect((card.split("</li>")[0].match(/<dt/g) ?? []).length).toBeLessThanOrEqual(3);
    expect(html).toContain(LIVE_MORE_AR);
    expect(html).not.toContain(LIVE_BACK_AR);
  });
  it("the work log: the newest line first, with its Cairo time; nothing when there is none", async () => {
    const data = await liveAnswer({ sheet: null, offset: 0, limit: 10 });
    const html = renderToStaticMarkup(createElement(LiveWorkLog, { lines: data.workLog }));
    expect(html).toContain(LIVE_WORK_LOG_TITLE_AR);
    expect(html).toContain("١٠:٣١");
    expect(html).toContain("أضفنا ٣٠ تعليقًا");
    expect(renderToStaticMarkup(createElement(LiveWorkLog, { lines: [] }))).toBe("");
  });
  it("one view: the grid on a desktop, the cards on a phone, the work log under both", async () => {
    const data = await liveAnswer({ sheet: null, offset: 0, limit: 10 });
    const html = renderToStaticMarkup(createElement(LiveSheetView, { data }));
    expect(html).toMatch(/class="hidden sm:block"><section[^>]*data-testid="live-grid"/);
    expect(html).toMatch(/class="sm:hidden"><section[^>]*data-testid="live-cards"/);
    expect(html).toContain('data-testid="live-work-log"');
  });
});

describe("where it is shown, and its words", () => {
  it("on the requests page only, and only when the mission answer says the flag is on", () => {
    const card = readFileSync("src/components/mission/AgentMissionCard.tsx", "utf8");
    expect(card).toContain('const showLive = stage2 && answer?.liveSheet === true && (v.phase === "running" || v.phase === "done" || v.phase === "partial");');
    const route = readFileSync("src/app/api/missions/[id]/route.ts", "utf8");
    expect(route).toContain('const liveSheet = await stage2FlagForMission(client, "DIGER_STAGE2_LIVE_SHEET", id);');
    expect(readFileSync("src/app/dashboard/chat/page.tsx", "utf8")).not.toMatch(/LiveSheet|stage2/);
  });
  it("every fixed word passes the customer-text rules", () => {
    for (const t of [LIVE_COUNTER_TITLE_AR, LIVE_MORE_AR, LIVE_BACK_AR, LIVE_WORK_LOG_TITLE_AR]) {
      expect(checkCustomerText(t).issues, t).toEqual([]);
      expect(checkCustomerLabel(t).issues, t).toEqual([]);
    }
  });
});
