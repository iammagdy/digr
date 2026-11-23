import { describe, expect, it } from "vitest";
import { planWithLlm, runMap } from "../agent/src/llmPlanner/planner";
import { runEngine } from "../agent/src/engine/run";
import { createSourceGateway, stageScopeOf } from "../agent/src/engine/sourceGateway";
import { ItemStore } from "../agent/src/items/itemStore";
import { createMemoryStore } from "../agent/src/memoryStore";
import { directWebEndpoints } from "../agent/src/llmPlanner/catalogView";
import { approvingResearchReviewer } from "./helpers/researchReviewer";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { RAW_PATH } from "../agent/src/gateway";

const catalog = loadTregCatalog();
const NOW = Date.parse("2026-11-16T12:00:00Z");

describe("planner and engine end-to-end with Firecrawl after a mid-run cap", () => {
  it("T-6x Firecrawl after a mid-run Context.dev cap, through the real engine with the real map code", async () => {
    // 1. Plan with LLM: P-1 scenario with planned 40
    const answers: Record<string, unknown[]> = {
      request_plan: [{
        decision: "plan", understanding_ar: "آخر أربعين خبرًا عن الذكاء الاصطناعي في السعودية.", assumptions_ar: [], accepts_available: false,
        steps: [{ key: "news", title_ar: "الأخبار", platform: "web", capability: "web.search.news", parent: null, deliver: true, count: { total: 40, all: false }, topic: "الذكاء الاصطناعي في السعودية", search_terms: [] }],
      }],
      tool_choice: [{
        options: [{
          endpoint_id: "contextdev.search",
          params_json: JSON.stringify({ query: "الذكاء الاصطناعي في السعودية" }),
          more_params: [{ query: "سدايا" }],
        }],
      }],
      field_map: [
        { fields: { id: ["url"], title: ["title"], link: ["url"], text: ["description"] }, extra: [] },
      ],
    };
    const planningPages = new Map<string, unknown>();
    let planProbeSeq = 0;
    const planResult = await planWithLlm({ words: ["هات آخر ٤٠ خبر"], request: "", scoutAllowed: false }, {
      model: async ({ tool }) => {
        const next = (answers[tool.name] ?? []).shift();
        return next === undefined ? null : { input: next, costUsd: 0.001 };
      },
      catalog, access: null, today: "2026-11-16", webTools: directWebEndpoints({ contextdev: true, firecrawl: true }),
      probe: async (id) => {
        planProbeSeq += 1; const call_id = `call_${planProbeSeq}`;
        planningPages.set(call_id, { rows: Array.from({ length: 5 }, (_, k) => ({ title: `خبر ${k}`, url: `https://news.example/${k}`, description: "وصف" })) });
        return { ok: true, call_id, http_status: 200, rows_in_page: 5, has_more: false, next_cursor: null, shape: null, first_rows: [], warnings: [], saved: call_id };
      },
      readPage: async (id) => planningPages.get(id) ?? null,
    });
    expect(planResult.kind).toBe("plan");
    if (planResult.kind !== "plan") return;
    const plan = planResult.plan;
    const stageKey = plan.stages[0]!.key;

    // 2. Run engine with the plan
    const store = createMemoryStore();
    const missionId = "msn_fc_midrun";
    const items = await ItemStore.open(store, missionId);

    const callCounts: Record<string, number> = {};
    let execSeq = 0;
    const webCalls: Array<{ provider: string; query: string }> = [];

    const web = {
      async parsePage() { throw new Error("not used"); },
      async webScrape() { throw new Error("not used"); },
      async peopleSearch() { throw new Error("not used"); },
      async webSearch(args: { provider: string; query: string }) {
        const provider = args.provider;
        callCounts[provider] = (callCounts[provider] ?? 0) + 1;
        webCalls.push({ provider, query: args.query });
        execSeq += 1;
        const callId = `call_${execSeq}`;

        if (provider === "contextdev") {
          if (callCounts.contextdev === 1) {
            const hits = Array.from({ length: 20 }, (_, k) => ({
              url: `https://a/${k + 1}`,
              title: `خبر ${k + 1}`,
              description: `وصف ${k + 1}`,
            }));
            await store.putFile(missionId, RAW_PATH(callId), JSON.stringify({ rows: hits }), "application/json");
            return { ok: true as const, call_id: callId, rows_in_page: 20, next_cursor: null };
          }
          // contextdev call 2: refused daily_cap
          return { ok: false as const, call_id: callId, refused: "daily_cap", message: "daily cap" };
        }

        // Firecrawl provider: different hosts, Arabic and long titles, title: "", description: "", 15 hits per set
        const setNum = callCounts.firecrawl ?? 1;
        const hits = Array.from({ length: 15 }, (_, k) => {
          const idx = (setNum - 1) * 15 + k + 1;
          const host = setNum === 1 ? "fc-source-alpha.org" : "fc-source-beta.net";
          return {
            url: `https://${host}/article/${idx}`,
            title: k === 0 ? "" : k === 1 ? "تقرير إخباري شامل ومفصل عن تطورات الذكاء الاصطناعي في المملكة العربية السعودية لعام ٢٠٢٦" : `عنوان الخبر ${idx}`,
            description: k === 2 ? "" : `وصف مختصر ومفيد عن الخبر رقم ${idx}`,
          };
        });
        await store.putFile(missionId, RAW_PATH(callId), JSON.stringify({ rows: hits }), "application/json");
        return { ok: true as const, call_id: callId, rows_in_page: 15, next_cursor: null };
      },
    };

    const budget = { spentUsd: () => 0 };
    const gateway = {
      async tregCall() {
        return { ok: false as const, failed: true, http_status: 500, message: "no treg call expected" };
      },
    };
    const sources = createSourceGateway({ gateway: gateway as any, web: web as any, scope: stageScopeOf(plan), budget });

    const outcome = await runEngine({
      reviewer: approvingResearchReviewer(),
      items,
      store,
      plan,
      missionId,
      gateway: gateway as any,
      sources,
      sandbox: async (code, inputs) => ({ ok: true, resultJson: JSON.stringify(runMap(code, Object.values(inputs)[0])), logs: [] }),
      addEvent: async () => undefined,
      now: () => NOW,
      deadlineMs: NOW + 3_600_000,
      sleep: async () => undefined,
      redesignStages: new Set([stageKey]),
    });

    // EXPECT (h):
    // contextdev called exactly TWICE (no call after the cap: the capped family is skipped)
    expect(callCounts.contextdev).toBe(2);
    // firecrawl called >= 1 time and allowed by the stage scope
    expect(callCounts.firecrawl).toBeGreaterThanOrEqual(1);
    // rows delivered === 40 (20 from contextdev + 20 from Firecrawl)
    const accepted = items.acceptedRows(stageKey);
    expect(accepted).toHaveLength(40);
    // outcome stops is target_reached
    expect(outcome.stops[stageKey]).toBe("target_reached");

    // Check Firecrawl rows: non-empty id/link, empty title/description preserved and delivered without throwing
    const fcRows = accepted.filter((r) => String(r.id).includes("fc-source"));
    expect(fcRows.length).toBe(20);
    for (const r of fcRows) {
      expect(typeof r.id).toBe("string");
      expect((r.id as string).length).toBeGreaterThan(0);
      expect(typeof r.link).toBe("string");
      expect((r.link as string).length).toBeGreaterThan(0);
    }
    const emptyTitleRow = fcRows.find((r) => r.title === "");
    expect(emptyTitleRow).toBeDefined();
    expect(emptyTitleRow!.title).toBe("");
  });
});
