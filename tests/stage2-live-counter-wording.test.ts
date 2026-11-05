import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { liveAnswer } from "./helpers/stage2Live";
import { LiveSheetCards } from "../src/components/mission/LiveSheetCards";
import { counterAr, pollResponse, type LiveSnapshot } from "../src/lib/agentMission/stage2/liveSheet";
import { OVER_DELIVERED_NOTE_AR } from "../src/lib/agentMission/stage2/counterWording";
import { workLogLine } from "../src/lib/agentMission/stage2/workLog";
import { deliveredOfAr, itemNounOfPlan, GENERIC_ITEM_NOUN } from "../src/lib/agentMission/itemNoun";
import { normalizeDigits } from "../src/lib/arabicDigits";
import { checkCustomerText } from "../src/lib/agentMission/text";

/**
 * FINDING F-1 (integration rounds 2 and 3): when the delivery is ABOVE the plan's number the live counter said «١٠٩ من ٧٠», which reads as a contradiction, while the delivered Excel says why («تم تسليم ١٠٩ … (أكثر من ٧٠ … المحسوبة في الخطة …)»).
 * The numbers were always the same ones (`promisedTotalOf`); only the words were missing. No row is capped, hidden or invented: the counter shows the whole delivered number, the plan's number, and says that the delivery is above it.
 */
const snap = (delivered: number, promised: number | null, status: "running" | "done" = "running"): LiveSnapshot => ({
  v: 1, missionId: "m", cursor: `7.0.${status}`, status, delivered, promised, counterAr: counterAr(delivered, promised), workLog: [],
  sheets: [{ stageKey: "comments", nameAr: "التعليقات", headers: ["نص التعليق", "المعرّف"], rows: Array.from({ length: Math.min(delivered, 5) }, (_, i) => ({ id: `c${i}`, parentId: null, cells: [{ k: "text" as const, v: `t${i}` }, { k: "text" as const, v: `c${i}` }] })) }],
  builtAt: 0,
});
const nums = (s: string): number[] => (s.match(/[٠-٩٬]+/g) ?? []).map((x) => Number(normalizeDigits(x.replace(/٬/g, ""))));

describe("the counter's words in every state", () => {
  it("before execution: nothing delivered of a known number reads «٠ من ٤٠»", () => {
    expect(counterAr(0, 40)).toBe("٠ من ٤٠");
  });
  it("normal progress: «١٢ من ٤٠»", () => {
    expect(counterAr(12, 40)).toBe("١٢ من ٤٠");
    expect(counterAr(39, 40)).toBe("٣٩ من ٤٠");
  });
  it("exact completion: «٤٠ من ٤٠» (equal is NOT over-delivery)", () => {
    expect(counterAr(40, 40)).toBe("٤٠ من ٤٠");
  });
  it("over-delivery: the whole delivered number, the plan's number, and a sentence that the delivery exceeded the estimate; never «X من N» with X above N", () => {
    const t = counterAr(109, 70);
    expect(t).toBe(`١٠٩ (${OVER_DELIVERED_NOTE_AR(70)})`);
    expect(t).toContain("أكثر من التقدير البالغ ٧٠");
    expect(t).not.toMatch(/١٠٩ من ٧٠/);
    expect(nums(t)).toEqual([109, 70]);
    expect(counterAr(41, 40)).toContain("أكثر من التقدير البالغ ٤٠");
    expect(counterAr(1200, 40)).toContain("١٬٢٠٠");
  });
  it("unknown promised total (none or zero): only the delivered number, never an invented total", () => {
    expect(counterAr(12, null)).toBe("١٢");
    expect(counterAr(0, null)).toBe("٠");
    expect(counterAr(12, 0)).toBe("١٢");
  });
  it("the over-delivery wording passes the customer-text rules (no jargon, no English)", () => {
    expect(checkCustomerText(counterAr(109, 70)).issues).toEqual([]);
    expect(checkCustomerText(OVER_DELIVERED_NOTE_AR(70)).issues).toEqual([]);
  });
});

describe("the numbers on the screen are the Excel's numbers", () => {
  it("the real M12 rows (all stored comments and replies against the plan's number) are over the plan: the counter carries exactly the numbers of the Excel's own sentence", async () => {
    const data = await liveAnswer({ sheet: "comments", offset: 0, limit: 10 });
    expect(data.delivered).toBeGreaterThan(data.promised ?? 0); // this IS the finding's state, on real stored rows
    const excel = deliveredOfAr(data.delivered, data.promised ?? 0, GENERIC_ITEM_NOUN);
    expect(nums(excel)).toEqual(nums(data.counterAr));
    expect(data.counterAr).not.toMatch(/^[٠-٩٬]+ من [٠-٩٬]+$/);
    expect(data.counterAr).toContain("أكثر من التقدير");
    void itemNounOfPlan;
  });
});

describe("the poll answer, refresh and a stale worker", () => {
  it("the route's answer is built from the numbers: a snapshot stored by an OLDER worker with the old words still shows the honest wording", () => {
    const old = snap(109, 70);
    old.counterAr = "١٠٩ من ٧٠";
    const r = pollResponse(old, { cursor: null, sheet: null, offset: 0, limit: 10 });
    if (!r.changed) throw new Error("unchanged");
    expect(r.counterAr).toBe(counterAr(109, 70));
    expect(r.delivered).toBe(109);
    expect(r.promised).toBe(70);
  });
  it("a refresh (a poll with no cursor) and a later poll of the same snapshot give the same words", () => {
    const s = snap(109, 70, "done");
    const a = pollResponse(s, { cursor: null, sheet: null, offset: 0, limit: 10 });
    const b = pollResponse(s, { cursor: "x", sheet: null, offset: 0, limit: 10 });
    if (!a.changed || !b.changed) throw new Error("unchanged");
    expect(a.counterAr).toBe(b.counterAr);
  });
  it("a snapshot whose numbers cannot be trusted (not whole numbers) keeps its stored text rather than inventing one", () => {
    const bad = snap(3, 40);
    (bad as unknown as { delivered: unknown }).delivered = "three";
    const r = pollResponse(bad, { cursor: null, sheet: null, offset: 0, limit: 10 });
    if (!r.changed) throw new Error("unchanged");
    expect(r.counterAr).toBe(bad.counterAr);
  });
});

describe("the phone card and the work log say the same", () => {
  it("the phone counter carries the over-delivery sentence and never «X من N» with X above N", async () => {
    const data = await liveAnswer({ sheet: "comments", offset: 0, limit: 10 });
    const html = renderToStaticMarkup(createElement(LiveSheetCards, { data }));
    expect(html).toContain(`>${data.counterAr}<`);
    expect(html).toContain("أكثر من التقدير");
  });
  it("normal progress on the phone is unchanged", async () => {
    const data = await liveAnswer({ sheet: "comments", offset: 0, limit: 10 });
    const ok = { ...data, delivered: 12, promised: 40, counterAr: counterAr(12, 40) };
    expect(renderToStaticMarkup(createElement(LiveSheetCards, { data: ok }))).toContain(">١٢ من ٤٠<");
  });
  it("the work log's «المجموع الآن» and «انتهينا» lines use the same words when the total is above the stage's number", () => {
    const at = Date.parse("2026-11-04T08:31:00Z");
    const saved = workLogLine({ code: "items_saved", at, n: 30, total: 109, promised: 70, noun: "comments" });
    expect(saved?.textAr).toContain(counterAr(109, 70));
    expect(saved?.textAr).not.toMatch(/١٠٩ من ٧٠/);
    const done = workLogLine({ code: "stage_done", at, n: 109, promised: 70, noun: "comments" });
    expect(done?.textAr).toContain(counterAr(109, 70));
    // below or equal: unchanged
    expect(workLogLine({ code: "items_saved", at, n: 30, total: 30, promised: 40, noun: "comments" })?.textAr).toContain("٣٠ من ٤٠");
    expect(workLogLine({ code: "stage_done", at, n: 40, promised: 40, noun: "comments" })?.textAr).toContain("٤٠ من ٤٠");
  });
});
