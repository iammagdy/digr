import { describe, expect, it } from "vitest";
import { checkUnderstanding } from "../agent/src/llmPlanner/planner";
import { tregCallBoundOf } from "../agent/src/gateway";
import { ceilToMicroUsd } from "../src/lib/server/spendGate/bounds";
import { measuredCalls, measuredUnderstanding, runWorkerReplay, xNewsUnderstanding } from "./tools/planning-budget-worker-replay";
import { contactSampleCapUsd } from "../src/lib/agentMission/contactSampling";
import { planningBudgetFacts, webPlanningCeilingUsd } from "../src/lib/agentMission/planningBudget";
import { statsFromCalls } from "../src/lib/agentMission/sourceRanking";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { NOT_ADMIN } from "./helpers/agentHarness";

const catalog = loadTregCatalog();
const now = Date.parse("2026-11-26T12:00:00Z");
const context = {
  catalog, access: NOT_ADMIN, now,
  stats: statsFromCalls(measuredCalls(now)),
  ceilToMicroUsd,
  defaultAdmissionUsdOf: (id: string) => tregCallBoundOf(id, {}, catalog),
};

describe("planning USD admissions and exact customer card parity", () => {
  it("R6 keeps the fifth web proof available after four billed empty searches on the real worker path", async () => {
    const out = await runWorkerReplay({ id: "measured-rank", world: "measured", expected: "card" }, { qa: {}, catalog });
    const web = out.calls.filter((call) => call.endpoint === "firecrawl.search");
    expect(web.map(({ status, billedUsd }) => [status, billedUsd])).toEqual([
      ["empty", 0.03], ["empty", 0.03], ["empty", 0.03], ["empty", 0.03], ["ok", 0.03],
    ]);
    expect(out.card).toEqual([217.568, 5505, 4787, 22]);
    expect(out.settlement).toEqual([
      { chargedPoints: 0, releasedPoints: 5505 },
      { chargedPoints: 218, releasedPoints: 5287 },
    ]);
  });

  it("sizes measured web rank and affordable handover children independently", () => {
    const checked = checkUnderstanding(measuredUnderstanding, catalog, NOT_ADMIN);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(webPlanningCeilingUsd(checked.value, context)).toBe(0.1945);
    const handover = planningBudgetFacts(checked.value, context);
    expect(handover.budgetUsd).toBe(0.1254);
    expect(handover.stages[1]).toMatchObject({ callUsd: 0.00188, reserveUsd: 0.03 });
  });

  it("D-0235 caps the validated X-news web ceiling at $0.20", () => {
    const checked = checkUnderstanding(xNewsUnderstanding, catalog, NOT_ADMIN);
    if (!checked.ok) throw new Error("X-news fixture must validate");
    expect(webPlanningCeilingUsd(checked.value, { ...context, stats: new Map() })).toBe(0.20);
  });

  const xNewsReplay = { id: "x-news-web-envelope", world: "x-news", expected: "admissions" } as const;
  it.each([
    { name: "fresh planning", priorPlanningUsd: undefined, billedUsd: 0.09 },
    { name: "$0.03 already recorded", priorPlanningUsd: 0.03, billedUsd: 0.12 },
  ])("D-0235 delivers one X-news item with $name", async ({ priorPlanningUsd, billedUsd }) => {
    const out = await runWorkerReplay(xNewsReplay, { qa: {}, catalog, priorPlanningUsd });
    expect(out.webQueries).toHaveLength(3);
    expect(out.calls.filter(({ turn }) => turn === 1)).toMatchObject([
      { status: "empty", billedUsd: 0.03 },
      { status: "ok", rows: 1, billedUsd: 0.03 },
      { status: "empty", billedUsd: 0.03 },
    ]);
    expect(out.planning.billedUsd).toBe(billedUsd);
    expect(out.status).toEqual(["plan_ready"]);
    expect(out.card?.[3]).toBe(1);
  });

  it("D-0235 refuses a resumed X-news sample that would cross the per-request cap", async () => {
    const out = await runWorkerReplay(xNewsReplay, { qa: {}, catalog, priorPlanningUsd: 0.15 });
    expect(out.webQueries).toHaveLength(1);
    expect(out.calls.filter(({ turn }) => turn === 1)).toMatchObject([
      { status: "empty", billedUsd: 0.03 },
      { status: "refused", reason: "over_budget:planning", billedUsd: 0, reservedUsd: null },
    ]);
    expect(out.planning.billedUsd).toBe(0.18);
    expect(out.status).toEqual(["unserved"]);
    expect(out.card).toBeNull();
  });

  it.each([
    { name: "new turn", priorPlanningUsd: undefined, unknownWebCharge: false, transportCalls: 1 },
    { name: "recorded prior spend", priorPlanningUsd: 0.03, unknownWebCharge: false, transportCalls: 0 },
    { name: "unknown charge in the active turn", priorPlanningUsd: undefined, unknownWebCharge: true, transportCalls: 1 },
  ])("keeps a cheap single-stage web budget separate with $name", async ({ priorPlanningUsd, unknownWebCharge, transportCalls }) => {
    const out = await runWorkerReplay(
      { id: "single-web", world: "cheap-web", expected: "card" },
      { qa: {}, catalog, priorPlanningUsd, unknownWebCharge },
    );
    expect(out.webQueries).toHaveLength(transportCalls);
    expect(out.calls.some((row) => row.turn === 1 && row.billedUsd === 0.001)).toBe(true);
    if (!unknownWebCharge) {
      expect(out.calls.some((row) => row.turn === 1 && row.endpoint === "firecrawl.search" && row.reason?.startsWith("over_budget"))).toBe(true);
    }
  });

  it("admits the company sample and refuses the unaffordable catalog child before transport", async () => {
    const out = await runWorkerReplay({ id: "dear-child", world: "dear-child", expected: "admissions" }, { qa: {}, catalog });
    expect(out.calls.map(({ endpoint, status }) => [endpoint, status])).toEqual([
      ["aiark.companies.search", "ok"], ["enrichlayer.company.employees.list", "refused"],
    ]);
    expect(out.calls[1]).toMatchObject({ reason: "over_budget:planning", rows: null, billedUsd: 0, reservedUsd: null });
  });

  it.each([
    { route: "dear", fallbackComments: undefined, statuses: ["ok", "refused", "refused"], billedUsd: 0.02952 },
    { route: "affordable", fallbackComments: "affordable" as const, statuses: ["ok", "refused", "ok"], billedUsd: 0.03152 },
  ])("uses the flat owner-only fallback budget with $route comments", async ({ route, fallbackComments, statuses, billedUsd }) => {
    const out = await runWorkerReplay(
      { id: `facebook-owner-fallback-${route}`, world: "fallback", expected: "admissions", fallbackComments },
      { qa: {}, catalog },
    );
    expect(out.calls.map(({ status }) => status)).toEqual(statuses);
    expect(out.calls.slice(1).filter(({ status }) => status === "refused").every(({ reason, billedUsd }) =>
      reason === "over_budget:planning" && billedUsd === 0)).toBe(true);
    expect(out.planning.billedUsd).toBe(billedUsd);
  });

  it.each([false, true])("hands over a company and contact request with empty-model-steps=%s", async (emptyB2B) => {
    const out = await runWorkerReplay(
      { id: "b2b", world: "b2b", expected: "card" },
      {
        qa: { request_text: "عايز ٣ شركات برمجيات في المعادي ومدير كل شركة وإيميله وتليفونه" },
        catalog, emptyB2B,
      },
    );
    expect(out.status).toEqual(["plan_ready"]);
    expect(out.calls.map(({ status }) => status)).toEqual(["ok", "ok"]);
    expect(out.card?.[3]).toBe(6);
  });

  it("continues the same worker mission after a question without persisting raw budget Understanding", async () => {
    await runWorkerReplay({ id: "two-turn", world: "rumors", expected: "two-turn-card" }, {
      catalog,
      qa: { turn_texts: { turn1_request_text: "هات تغريدات عن الشائعات", turn2_answer_text: "سلّمني الموجود فقط" } },
      inspect(store) {
        const mission = store.missions.get("two-turn")!;
        expect(mission.answer_text).toBe("سلّمني الموجود فقط");
        expect(mission.plan?.compiled?.llm?.steps).toBeDefined();
        expect(Object.keys(mission)).not.toContain("plannerUnderstanding");
        const states = [...store.files].filter(([name]) => name.includes("/state/"));
        expect(states.map(([name]) => name)).toContain("two-turn/state/llm_planner.json");
        for (const [, state] of states) {
          expect(String(state)).not.toContain('"plannerUnderstanding"');
          expect(String(state)).not.toContain('"people_of_companies"');
        }
      },
    });
  });
});

describe("validated planning structures remain bounded", () => {
  it.each([undefined, "not-an-array", [{}]])("rejects unusable plan steps at the parser boundary (%j)", (steps) => {
    expect(checkUnderstanding({ ...measuredUnderstanding, steps }, catalog, NOT_ADMIN).ok).toBe(false);
  });

  it("keeps the selected default parent sample funded across prior-spend and child combinations", () => {
    const u = checkUnderstanding(measuredUnderstanding, catalog, NOT_ADMIN);
    expect(u.ok).toBe(true);
    if (!u.ok) return;
    const vary = [undefined, { asked: true }, { asked: false }] as const;
    for (let seed = 0; seed < 100; seed++) {
      const spentUsd = ((seed * 18917) % 200001) / 1e6;
      const facts = planningBudgetFacts({ steps: u.value.steps.slice(0, seed % 2 + 1), people_of_companies: vary[seed % vary.length] }, context, spentUsd);
      const reserves = facts.stages.reduce((sum, stage) => sum + stage.reserveUsd, 0);
      const parent = facts.stages.find((stage) => stage.role !== "child");
      const bound = parent?.sourceId ? context.defaultAdmissionUsdOf(parent.sourceId) ?? 0 : 0;
      expect(facts.baseUsd).toBeGreaterThanOrEqual(0.05);
      expect(facts.budgetUsd).toBeLessThanOrEqual(0.2);
      expect(contactSampleCapUsd(facts.budgetUsd)).toBeLessThanOrEqual(0.05);
      expect(reserves).toBeLessThanOrEqual(Math.max(0, facts.budgetUsd - spentUsd - bound) + 1e-9);
    }
  });
});
