import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readWorkbook, replay, type ReplayResult } from "./helpers/agentReplay";
import { dispatcher, planFlow } from "./helpers/g1World";
import { LIVE_7539, stage3Dispatcher, testAccountStore } from "./helpers/stage3World";
import { stagePriceInputs } from "../src/lib/agentMission/plan";
import { priceMissionByCode } from "../src/lib/agentMission/price";
import { B2B_CARDS } from "../src/lib/agentMission/stage3/b2bCards";

/**
 * STAGE 3, PART A WIRING (behind DIGER_STAGE3_COMPANIES): with the flag on for the account, the worker's planning of a companies and decision-makers request is the code-built plan
 * (stage3/b2bPlan.ts): NO model turn, NO provider call at planning, verified cards only, priced by the existing function; the mission is then approved, run by today's engine and settled as
 * any plan. With the flag unset (tests/stage3-flags-off.test.ts) or `test` for a customer, today's model path runs unchanged. A request the code path does not plan keeps today's path.
 */
afterEach(() => vi.unstubAllEnvs());
const VERIFIED = new Set(B2B_CARDS.filter((c) => c.status === "verified").map((c) => c.endpointId));
const sha = (v: unknown): string => createHash("sha256").update(JSON.stringify(v, (k, x) => (k === "measured_ms_per_row" ? undefined : x))).digest("hex").slice(0, 16);
const codeRun = (flag: string, opts: { test?: boolean; request?: string } = {}): Promise<ReplayResult> => {
  vi.stubEnv("DIGER_STAGE3_COMPANIES", flag);
  return replay({ request: opts.request ?? LIVE_7539, planning: [], execution: () => [], answers: Array.from({ length: 300 }, () => stage3Dispatcher()), ...(opts.test ? { makeStore: testAccountStore } : {}) });
};

describe("flag «on»: the companies plan is made by code", () => {
  it("no model turn and no provider call before approval; the plan is the code-built one, verified cards only, priced by priceMissionByCode", async () => {
    const r = await codeRun("on");
    expect(r.planningDriver.results).toEqual([]);
    expect(r.store.calls.filter((c) => (c.phase ?? "planning") === "planning")).toEqual([]);
    const plan = r.plannedPlan;
    expect(plan.stages.map((s) => s.engine?.built_by)).toEqual(["code", "code"]);
    const lookups = [...plan.stages.map((s) => s.endpoint_id), ...(plan.contact_steps ?? []).flatMap((s) => [...s.finders, ...(s.company_phone ?? [])].map((f) => f.id))];
    for (const id of lookups) expect(VERIFIED.has(id), id).toBe(true);
    expect(plan.price).toEqual(priceMissionByCode(stagePriceInputs(plan.stages, plan.contact_steps), { settings: plan.price.settings }));
    expect(plan.price.reservePoints).toBeLessThanOrEqual(25_000);
    expect(r.store.events.some((e) => (e.counts as Record<string, number> | undefined)?.b2b_compiled === 1)).toBe(true);
  }, 60_000);

  it("the approved plan runs on today's engine to the end: five companies with their HQ phone from the maps lookup, two decision makers each with their e-mail; the charge is the delivered rows", async () => {
    const r = await codeRun("on");
    const m = r.mission;
    expect(m.status).toBe("completed");
    expect(Number(m.delivered_units)).toBe(15);
    expect(m.charged_points).toBe(Math.min(Math.ceil(Math.round(15 * r.plannedPlan.price.unitPricePoints * 1e6) / 1e6 - 1e-9), r.plannedPlan.price.reservePoints));
    const wb = await readWorkbook(r);
    const text = JSON.stringify(wb.worksheets.map((ws) => ws.getSheetValues()));
    expect(text).toContain("+20 2 2574 0001");
    expect(text).toContain("p0@orascom-em.com.eg");
  }, 60_000);
});

describe("flag «test»: only a test account gets the code path", () => {
  it("a test account: the plan is made by code", async () => {
    const r = await codeRun("test", { test: true });
    expect(r.planningDriver.results).toEqual([]);
    expect(r.plannedPlan.stages.every((s) => s.engine?.built_by === "code")).toBe(true);
  }, 60_000);
  it("a customer: today's model path, giving the same plan object as with the flag unset", async () => {
    vi.stubEnv("DIGER_STAGE3_COMPANIES", "test");
    const r = await replay({ request: LIVE_7539, planning: planFlow("electromechanical"), execution: () => [], answers: Array.from({ length: 200 }, () => dispatcher({})) });
    expect(r.planningDriver.results.length).toBeGreaterThan(0);
    const expected = (JSON.parse(readFileSync(new URL("./fixtures/stage3-flags-off.json", import.meta.url), "utf8")) as { worlds: Record<string, { plan: string }> }).worlds.live_7539_words.plan;
    const clean = JSON.parse(JSON.stringify(r.plannedPlan).replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, "<time>").replace(/msn_[0-9a-f]{20}/g, "<mission>").replace(/job_[0-9a-f-]+/g, "<job>"));
    expect(sha(clean)).toBe(expected);
  }, 60_000);
});

describe("flag on, a request the code path does not plan: today's model path", () => {
  it("a companies request with a condition (its mark column is not wired yet) is planned by the model as today", async () => {
    vi.stubEnv("DIGER_STAGE3_COMPANIES", "on");
    const r = await replay({ request: `${LIVE_7539} وعدد موظفيها أكثر من ٥٠`, planning: planFlow("electromechanical"), execution: () => [], answers: Array.from({ length: 200 }, () => dispatcher({})) });
    expect(r.planningDriver.results.length).toBeGreaterThan(0);
    expect(r.store.events.some((e) => (e.counts as Record<string, number> | undefined)?.b2b_compiled === 0)).toBe(true);
  }, 60_000);
});
