import { describe, expect, it } from "vitest";
import { assertReplayInvariants, readWorkbook, replay, type ReplayResult } from "./helpers/agentReplay";
import { ENDPOINT, TOPIC, page, pages, planning as xPlanning, PER_PAGE, pad } from "./helpers/engineXScenario";
import { tregResult } from "./helpers/agentFakeWorld";
import { readSnapshot } from "../agent/src/items/itemStore";
import { buildMissionNotice } from "../src/lib/agentMission/notices";
import { requestedRowsOf } from "../src/lib/agentMission/plan";
import type { FakeStep } from "../agent/src/fakeDriver";

/**
 * THE CUSTOMER'S QUANTITY IS THE TARGET, EVERYWHERE, AND THE CHARGE IS SETTLED AGAINST IT. The request says how many (digits, Arabic-Indic digits, words, dialect); the model proposed another number; code sets the target from the customer's words.
 * The card (headline, stage line, total), the tracker, the file's summary sheet and the settlement are ONE number. A delivery below the request is never «complete» and never written «N من N».
 */
const withPlan = (steps: FakeStep[], change: (stage: Record<string, unknown>, top: Record<string, unknown>) => Record<string, unknown> | void): FakeStep[] =>
  steps.map((s) => (s.tool !== "propose_plan" ? s : { ...s, args: (res: any) => {
    const plan = (s.args as (r: unknown) => any)(res);
    const stage = { ...plan.stages[0] };
    const top = { ...plan };
    const out = change(stage, top);
    return { ...top, ...(out ?? {}), stages: [stage] };
  } }));

const summarySheet = async (r: ReplayResult) => {
  const wb = await readWorkbook(r);
  const sheet = wb.worksheets[0];
  return { stageRow: sheet.getRow(2).values as unknown[], intro: String(sheet.getRow(4).getCell(1).value) };
};

describe("the target is the customer's number, however it is written", () => {
  it.each([
    ["هات ٣٠٠ تغريدة عن محمد صلاح"],
    ["هات 300 تغريدة عن محمد صلاح"],
    ["هات تلتمية تغريدة عن محمد صلاح"],
  ])("«%s»: the model wrote 200; the card, the tracker, the events, the file's summary and the settlement all say 300", async (request) => {
    const r = await replay({ request, planning: withPlan(xPlanning(), (stage) => { stage.expected_rows = 200; }), execution: () => [], answers: [pages(1)[0], ...pages(30)] });
    assertReplayInvariants(r, { expectDelivered: 300 });
    // the plan: one number
    expect(r.plannedPlan.stages[0]).toMatchObject({ planned_rows: 300, expected_rows: 300 });
    expect(r.plannedPlan.price.deliveredRows).toBe(300);
    expect(r.plannedPlan.quantity).toEqual({ requested: 300, stage_key: "tweets", target: 300, source: "request" });
    expect(requestedRowsOf(r.plannedPlan)).toBe(300);
    // the card
    expect(r.planView.totalRows).toBe(300);
    expect(r.planView.requestedRows).toBe(300);
    expect(r.planView.stages[0]).toMatchObject({ rows: 300, rowsAr: "٣٠٠ تغريدة" });
    // the live numbers: every progress event states the same target
    const planned = r.store.events.filter((e) => typeof e.counts?.planned === "number").map((e) => e.counts!.planned);
    expect(planned.length).toBeGreaterThan(0);
    expect(new Set(planned)).toEqual(new Set([300]));
    expect(r.store.events.find((e) => e.kind === "plan")!.counts!.rows).toBe(300);
    // the tracker
    expect(r.finalView.steps[0]).toMatchObject({ countAr: "٣٠٠ من ٣٠٠ تغريدة", savedN: 300, plannedN: 300 });
    // the file's summary sheet: the expected count and the sentence
    const s = await summarySheet(r);
    expect(s.stageRow[4]).toBe(300);
    expect(s.intro).toBe("تم تسليم ٣٠٠ من ٣٠٠ تغريدة.");
    // the settlement: against the same target
    expect(r.mission.delivered_units).toBe(300);
    expect(r.finalView.resultLinesAr[0]).toBe("تم تسليم ٣٠٠ من ٣٠٠ تغريدة.");
    expect(r.notices[0]).toMatchObject({ kind: "completed", facts: { delivered: 300, planned: 300 } });
  });
});

describe("FEWER than the customer asked for, only with a reason the card shows (the replay of the mission that said «حتى ٣٠٠» and delivered ١٢٠ of ١٢٠)", () => {
  const REASON = "المصدر لا يعطي أكثر من هذا العدد من التغريدات الأصلية";
  const run = () => replay({
    request: "هات ٣٠٠ تغريدة عن محمد صلاح",
    planning: withPlan(xPlanning(), (stage, top) => { stage.expected_rows = 120; stage.target_reason_ar = REASON; top.summary_ar = "ستحصل على تغريدات عن محمد صلاح مع نص كل تغريدة ورابطها."; }),
    execution: () => [], answers: [pages(1)[0], ...pages(30)],
  });

  it("the card shows ONE target (the lower one) and the reason; no text on the card says ٣٠٠", async () => {
    const r = await run();
    expect(r.plannedPlan.quantity).toMatchObject({ requested: 300, target: 120, reason_ar: REASON });
    expect(r.plannedPlan.stages[0].planned_rows).toBe(120);
    expect(r.planView.totalRows).toBe(120);
    expect(r.planView.stages[0]).toMatchObject({ rows: 120, rowsAr: "١٢٠ تغريدة" });
    expect(r.planView.notesAr).toContain(REASON);
    const card = JSON.stringify([r.planView.summaryAr, r.planView.stages, r.planView.notesAr, r.planView.assumptionsAr, r.planView.priceLineAr, r.planView.priceFacts]);
    expect(card).not.toContain("٣٠٠");
    expect(r.planView.requestedRows).toBe(300);
  });

  it("it is NEVER «complete» and never «١٢٠ من ١٢٠»: the file, the panel, the notice and the e-mail say ١٢٠ من ٣٠٠; the charge is settled against the approved target (full delivery = the card price)", async () => {
    const r = await run();
    assertReplayInvariants(r, { expectDelivered: 120, expectStatus: "partial" });
    expect(r.mission.status).toBe("completed");
    expect(r.finalView.phase).toBe("partial");
    expect(r.finalView.resultLinesAr[0]).toBe("تم تسليم ١٢٠ من ٣٠٠ تغريدة.");
    const s = await summarySheet(r);
    expect(s.intro).toBe("تم تسليم ١٢٠ من ٣٠٠ تغريدة.");
    expect(s.stageRow[4]).toBe(120);
    // the card price is the price of the full delivery of the approved target: 120 delivered = the charge the card showed
    expect(r.mission.charged_points).toBe(r.plannedPlan.price.maxChargePoints);
    expect(r.mission.charged_points).toBe(200);
    expect(r.notices[0]).toMatchObject({ kind: "partial", facts: { delivered: 120, planned: 300 } });
    const notice = buildMissionNotice(r.notices[0].kind, r.notices[0].facts, "تغريدات عن محمد صلاح");
    for (const text of [notice.title, notice.body, notice.email!.subject, notice.email!.lead]) expect(text).not.toContain("١٢٠ من ١٢٠");
    expect(notice.body).toContain("١٢٠ من ٣٠٠");
    expect(notice.body).toContain(REASON);
    // the stored summary says why, in the plan's own reason
    expect(r.mission.summary_ar).toContain("أقل مما طلبت");
    expect(r.mission.summary_ar).toContain(REASON);
    for (const text of [r.mission.summary_ar!, ...r.finalView.resultLinesAr, s.intro]) expect(text).not.toMatch(/١٢٠ من ١٢٠/);
  });
});

describe("fewer than the target: PROPORTIONAL (ceil(delivered x unit)), never above the reserve; the sources gave fewer than asked", () => {
  it("300 asked, the source ends after 96 matching tweets: 96 delivered, 64 charged (the unit is ٠٫٦٦٦٦٦٦), written «٩٦ من ٣٠٠», with the recorded reason", async () => {
    const end = Array.from({ length: 6 }, (_, p) => tregResult(page(p * PER_PAGE, p < 5 ? `cur_${(p + 1) * PER_PAGE}` : null), 0.00075));
    const r = await replay({ request: "هات ٣٠٠ تغريدة عن محمد صلاح", planning: xPlanning(), execution: () => [], answers: [pages(1)[0], ...end] });
    assertReplayInvariants(r, { expectDelivered: 96, expectStatus: "partial" });
    expect(r.plannedPlan.price.unitPricePoints).toBe(0.666666);
    expect(r.mission.charged_points).toBe(Math.ceil(96 * 0.666666));
    expect(r.mission.charged_points).toBe(64);
    expect(Number(r.mission.charged_points)).toBeLessThan(Number(r.mission.reserved_points));
    expect(r.finalView.phase).toBe("partial");
    expect(r.finalView.resultLinesAr[0]).toBe("تم تسليم ٩٦ من ٣٠٠ تغريدة.");
    expect(r.finalView.resultLinesAr[1]).toBe("خُصم ٦٤ نقطة مقابل ٩٦ تغريدة.");
    expect(r.mission.summary_ar).toContain("لم يكتمل العدد المطلوب");
    expect((await summarySheet(r)).intro).toBe("تم تسليم ٩٦ من ٣٠٠ تغريدة.");
    const snap = await readSnapshot(r.store, r.missionId);
    expect(snap.stage("tweets").stop).toBe("source_exhausted");
  });

  it("nothing matching delivered: no charge at all, the hold released whole", async () => {
    const junk = Array.from({ length: 3 }, (_, p) => tregResult({ output: { data: { items: Array.from({ length: PER_PAGE }, (_, i) => ({ id: `99${pad(p * PER_PAGE + i)}`, text: `أخبار الطقس رقم ${p * PER_PAGE + i}`, url: `https://x.example/j/${p}${i}`, author: "u", createdAt: "2026-10-20T10:00:00Z" })), nextCursor: p < 2 ? `cur_${p + 1}` : null } } }, 0.00075));
    const r = await replay({ request: "هات ٣٠٠ تغريدة عن محمد صلاح", planning: xPlanning(), execution: () => [], answers: [pages(1)[0], ...junk] });
    expect(r.mission.status).toBe("unserved");
    expect(r.mission.delivered_units).toBe(0);
    expect(r.mission.charged_points).toBe(0);
    expect(r.money.balance()).toBe(r.initialBalance);
    expect(ENDPOINT.length).toBeGreaterThan(0);
    expect(TOPIC.length).toBeGreaterThan(0);
  });
});
