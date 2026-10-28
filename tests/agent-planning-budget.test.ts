import { describe, expect, it, vi } from "vitest";
import { createFakeDriver } from "../agent/src/fakeDriver";
import { createMemoryStore, newMission } from "../agent/src/memoryStore";
import { runPlanning, type RunnerDeps } from "../agent/src/runMission";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { NOT_ADMIN, USER_ID, fakeRecorder, tregResult } from "./helpers/agentHarness";
import { fakeMoneyClient } from "./helpers/agentMoney";
import { customerMissionView } from "../src/lib/agentMission/customerView";

vi.stubGlobal("fetch", () => { throw new Error("a real network call was attempted"); });
const DEAR = "anyapi.facebook.search_posts"; // 0.06606 USD a call: above 0.05, below 0.10

async function planWith(request: string) {
  const store = createMemoryStore();
  store.missions.set("msn_b1", newMission({ id: "msn_b1", user_id: USER_ID, request_text: request, status: "planning" }));
  const rec = fakeRecorder();
  const call = vi.fn(async () => tregResult({ output: { data: { items: [{ id: "p1", text: "x", url: "https://f.example/1" }] } } }, 0.06606));
  const driver = createFakeDriver([{ tool: "treg_call", args: { endpoint_id: DEAR, params: { query: "غذاء" }, why: "the only source with the post fields in its description" } }], { stopAfterTerminal: false });
  const deps: RunnerDeps = { store, client: fakeMoneyClient().client, catalog: loadTregCatalog(), driver, recorder: rec.recorder, commit: rec.commit, call: call as any, models: { planning: "claude-haiku-5-5", execution: "claude-haiku-5-5" }, resolveAccess: async () => NOT_ADMIN };
  await runPlanning(deps, store.missions.get("msn_b1")!);
  return { result: driver.results[0].result, call };
}

describe("the planning exploration budget is raised for a multi-stage request (0.10 USD), not for a single-stage one (0.05 USD)", () => {
  it("a call of 0.066 USD is refused when planning a one-stage request and made when planning posts WITH their comments", async () => {
    const single = await planWith("هات منشورات فيسبوك عن غذاء");
    expect(single.result).toMatchObject({ ok: false, refused: "over_budget" });
    expect(single.call).not.toHaveBeenCalled();
    const multi = await planWith("هات منشورات فيسبوك عن غذاء مع تعليقات كل منشور");
    expect(multi.result.ok).toBe(true);
    expect(multi.call).toHaveBeenCalledTimes(1);
  });
});

describe("the live panel while a source is being paged through", () => {
  const row = { id: "msn_p0001", status: "executing", question_ar: null, plan_public: { summary_ar: "ستحصل على تغريدات.", stages: [{ key: "t", title_ar: "التغريدات", expected_rows: 300, parent_key: null, deliver: true, columns: [{ key: "text", title_ar: "النص" }], sample_rows: [] }], price: { unit_price_points: 0.2, reserve_points: 72, max_charge_points: 62, delivered_rows: 300 }, expected_minutes: 3 }, reserved_points: 72, unit_price_points: 0.2, delivered_units: null, charged_points: null, summary_ar: null, files: null, created_at: "2026-10-28T10:00:00Z" };
  const at = (s: number) => new Date(Date.parse("2026-10-28T10:00:00Z") + s * 1000).toISOString();

  it("says how many rows were collected so far and the time left from the REAL speed of the paging, before any row is saved", () => {
    const events = [
      { id: 1, kind: "progress", message_ar: "يجمع الوكيل الصفحات من المصدر صفحة بعد صفحة", counts: { pages: 1, rows: 20, planned: 300 }, created_at: at(10) },
      { id: 2, kind: "progress", message_ar: "يجمع الوكيل الصفحات من المصدر صفحة بعد صفحة", counts: { pages: 5, rows: 100, planned: 300 }, created_at: at(50) },
    ];
    const v = customerMissionView({ mission: row, events, now: Date.parse(at(55)) });
    expect(v.steps[0]).toMatchObject({ state: "running" });
    // (was «جُمع ١٠٠ من ٣٠٠ من المصدر حتى الآن», which sat next to «٠ من ٣٠٠» in the bar: two numbers for one thing) one progress number: the rows in the file; the source's pages are counted as pages
    expect(v.steps[0].detailAr).toBe("قُرئت ٥ صفحات من المصدر، ويُحفظ في ملفك ما يطابق طلبك فقط");
    expect(v.steps[0].countAr).toBe("٠ من ٣٠٠");
    // 80 rows in 40 s = 2 rows a second; 200 left = 100 s
    expect(v.remainingAr).toMatch(/^المتبقي /);
    expect(v.remainingAr).toContain("دقيقتين");
  });
  it("with one sample only there is no time estimate (never a guess)", () => {
    const v = customerMissionView({ mission: row, events: [{ id: 1, kind: "progress", message_ar: "يجمع الوكيل الصفحات من المصدر صفحة بعد صفحة", counts: { pages: 1, rows: 20, planned: 300 }, created_at: at(10) }], now: Date.parse(at(12)) });
    expect(v.remainingAr).toBeNull();
    expect(v.steps[0].detailAr).toContain("قُرئت صفحة واحدة من المصدر"); // (was «جُمع ٢٠ من ٣٠٠»)
  });
});
