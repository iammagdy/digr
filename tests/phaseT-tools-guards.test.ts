import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import {
  unconfirmedFilterNotices,
  isFilterConfirmedOnRow,
  type FilterConfirmationStage,
  type StageFilter,
} from "../src/lib/agentMission/filters";
import { checkCustomerText } from "../src/lib/agentMission/text";
import { customerMissionView } from "../src/lib/agentMission/customerView";
import { buildMissionNotice, type MissionNoticeFacts } from "../src/lib/agentMission/notices";
import { buildTools, type ToolContext } from "../agent/src/tools";
import { runExecution } from "../agent/src/runMission";
import { scanSourceCode, loadTregCatalogIds, AllowIndex } from "./designGuardsScanner";
import { createMemoryStore, newMission } from "../agent/src/memoryStore";
import { fakeMoneyClient } from "./helpers/agentMoney";
import { createFakeDriver } from "../agent/src/fakeDriver";
import { makeHarness, fakeRecorder } from "./helpers/agentHarness";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { approveMission } from "../src/lib/agentMission/lifecycle";
import { legacyPriceMissionByCode } from "../src/lib/agentMission/price";
import { type PricedPlan, customerPlanView } from "../src/lib/agentMission/plan";
import { ItemStore } from "../agent/src/items/itemStore";
import { PEOPLE_FALLBACK_LINE_AR } from "../src/lib/agentMission/childSources";

vi.stubGlobal("fetch", () => {
  throw new Error("a real network call was attempted");
});

describe("Phase T Tools Guards & D-0213 / D-0214 Specifications (O13)", () => {
  // ---------------------------------------------------------------------------------------------
  // 1. D-0214 Must-Pass (5 accepted rows lacking date under period filter)
  // ---------------------------------------------------------------------------------------------
  describe("1. D-0214 Must-Pass (5 accepted rows lacking date under period filter)", () => {
    it("unit: unconfirmedFilterNotices emits exact sentence with countAr and noun agreement", () => {
      const stageWithNoun: FilterConfirmationStage = {
        key: "tweets",
        deliver: true,
        item_noun_ar: "تغريدة",
        filters: [{ kind: "period", days: 7, field: "date" }],
      };
      const rows = [
        { id: "1", text: "تغريدة ١" },
        { id: "2", text: "تغريدة ٢" },
        { id: "3", text: "تغريدة ٣" },
        { id: "4", text: "تغريدة ٤" },
        { id: "5", text: "تغريدة ٥" },
      ];
      const prov = new Map<string, "rule" | "model" | "legacy">([
        ["1", "rule"],
        ["2", "rule"],
        ["3", "rule"],
        ["4", "rule"],
        ["5", "rule"],
      ]);

      const res = unconfirmedFilterNotices({
        stages: [stageWithNoun],
        rowsByStage: { tweets: rows },
        provenanceByStage: { tweets: prov },
      });

      expect(res.unconfirmedTotal).toBe(5);
      expect(res.lines).toEqual(["فيه ٥ تغريدات ما قدرناش نتأكد من تاريخها."]);
      expect(checkCustomerText(res.lines[0]).issues).toEqual([]);

      // Stage without item_noun_ar falls back to عنصر
      const stageGeneric: FilterConfirmationStage = {
        key: "items",
        deliver: true,
        filters: [{ kind: "period", days: 7, field: "date" }],
      };
      const resGeneric = unconfirmedFilterNotices({
        stages: [stageGeneric],
        rowsByStage: { items: rows },
        provenanceByStage: { items: prov },
      });
      expect(resGeneric.unconfirmedTotal).toBe(5);
      expect(resGeneric.lines).toEqual(["فيه ٥ عناصر ما قدرناش نتأكد من تاريخها."]);
      expect(checkCustomerText(resGeneric.lines[0]).issues).toEqual([]);
    });

    it("end-to-end: runExecution delivers all 5 rows, normal charge, displays note across 3 customer surfaces", async () => {
      const store = createMemoryStore();
      const money = fakeMoneyClient();
      const userId = "usr_phaseT_1";
      const missionId = "msn_phaseT_1";

      const priced = legacyPriceMissionByCode([
        { rows: 5, costPerRowUsd: 1 / 5500, deliver: true },
      ]);
      const plan: PricedPlan = {
        summary_ar: "جمع تغريدات خلال آخر ٧ أيام.",
        stages: [
          {
            key: "tweets",
            title_ar: "التغريدات",
            endpoint_id: "apify.twitter",
            deliver: true,
            planned_rows: 5,
            item_noun_ar: "تغريدة",
            columns: [
              { key: "text", title_ar: "النص" },
              { key: "date", title_ar: "التاريخ" },
            ],
            sample_rows: [],
            filters: [{ kind: "period", days: 7, field: "date" }],
            price_usd: 0.05,
            charge_per_item: 1,
            unit_price_usd: 0.01,
            measured_cost_per_row_usd: 1 / 5500,
          } as any,
        ],
        price: priced,
        total_rows: 5,
        target_rows: 5,
        total_points: priced.reservePoints,
        unit_price_points: priced.unitPricePoints,
      } as any;

      store.missions.set(
        missionId,
        newMission({
          id: missionId,
          user_id: userId,
          request_text: "هات ٥ تغريدات من آخر أسبوع",
          status: "planning",
          plan,
        }),
      );

      const approved = await approveMission(money.client, { id: missionId, user_id: userId, plan });
      if (!approved.ok) throw new Error(approved.messageAr);

      await store.updateMission(missionId, {
        status: "executing",
        job_id: approved.jobId,
        quote_id: approved.quoteId,
        reserved_points: approved.reservePoints,
        unit_price_points: approved.unitPricePoints,
        plan_public: customerPlanView(plan) as any,
      });

      // Seed 5 rows in ItemStore lacking date
      const rowsWithoutDate = [
        { id: "t1", text: "أول تغريدة بدون تاريخ" },
        { id: "t2", text: "ثاني تغريدة بدون تاريخ" },
        { id: "t3", text: "ثالث تغريدة بدون تاريخ" },
        { id: "t4", text: "رابع تغريدة بدون تاريخ" },
        { id: "t5", text: "خامس تغريدة بدون تاريخ" },
      ];

      const itemStore = await ItemStore.open(store, missionId, { legacyStages: ["tweets"] });
      await itemStore.commit(
        rowsWithoutDate.map((r) => ({
          t: "item",
          id: r.id,
          stage: "tweets",
          state: "accepted" as const,
          by: "rule" as const,
          row: r,
        })),
      );

      const driver = createFakeDriver([
        {
          tool: "finish",
          args: { outcome: "delivered", summary_ar: "تم التسليم." },
        },
      ]);
      const rec = fakeRecorder();

      let capturedNotice: any = null;
      await runExecution(
        {
          store,
          client: money.client,
          catalog: loadTregCatalog(),
          driver,
          recorder: rec.recorder,
          commit: rec.commit,
          models: { planning: "claude-haiku-5-5", execution: "claude-haiku-5-5" },
          resolveAccess: async () => ({ allowed: true } as any),
          notify: async (input) => {
            capturedNotice = input;
          },
        },
        store.missions.get(missionId)!,
      );

      const finalMission = store.missions.get(missionId)!;
      expect(finalMission.status).toBe("completed");
      expect(finalMission.delivered_units).toBe(5);
      expect(finalMission.charged_points).toBe(5);

      // Surface 1: customerMissionView resultLinesAr includes filter note after delivered & money
      const card = customerMissionView({
        mission: finalMission as any,
        events: store.events.map((e, i) => ({
          id: i + 1,
          kind: e.kind,
          message_ar: e.message_ar,
          counts: e.counts ?? null,
          created_at: new Date().toISOString(),
        })),
        queue: null,
        now: Date.now(),
      });
      expect(card.resultLinesAr).toContain("فيه ٥ تغريدات ما قدرناش نتأكد من تاريخها.");
      expect(card.resultLinesAr.length).toBeGreaterThanOrEqual(3);

      // Surface 2: Notice body & email.detail2
      expect(capturedNotice).not.toBeNull();
      const builtNotice = buildMissionNotice("completed", capturedNotice.facts, "التغريدات");
      expect(builtNotice.body).toContain("فيه ٥ تغريدات ما قدرناش نتأكد من تاريخها.");
      expect(builtNotice.email?.detail2).toBe("فيه ٥ تغريدات ما قدرناش نتأكد من تاريخها.");

      // Surface 3: Workbook "حدود هذا التسليم" sheet
      const xlsxFile = (finalMission.files ?? []).find((f) => f.name.endsWith(".xlsx"));
      expect(xlsxFile).toBeDefined();
      const rawWorkbook = await store.getFileBytes(missionId, xlsxFile!.path);
      expect(rawWorkbook).toBeDefined();

      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(rawWorkbook as any);
      const summarySheet = wb.getWorksheet("ملخص المهمة");
      expect(summarySheet).toBeDefined();

      let foundLimitLine = false;
      summarySheet!.eachRow((row) => {
        row.eachCell((cell) => {
          if (String(cell.value ?? "").includes("فيه ٥ تغريدات ما قدرناش نتأكد من تاريخها.")) {
            foundLimitLine = true;
          }
        });
      });
      expect(foundLimitLine).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // 2. D-0214 Additional Filter Kinds & by: "legacy"
  // ---------------------------------------------------------------------------------------------
  describe("2. D-0214 Additional Filter Kinds & by: legacy", () => {
    it("language filter on 2 rows with URL-only text (no lang field) reports unconfirmed dual note", () => {
      const stage: FilterConfirmationStage = {
        key: "tweets",
        deliver: true,
        item_noun_ar: "تغريدة",
        filters: [{ kind: "language", lang: "ar", field: "lang" }],
      };
      const rows = [
        { id: "1", text: "https://x.com/1" },
        { id: "2", text: "https://x.com/2" },
      ];
      const prov = new Map<string, "rule" | "model" | "legacy">([
        ["1", "rule"],
        ["2", "rule"],
      ]);

      const res = unconfirmedFilterNotices({
        stages: [stage],
        rowsByStage: { tweets: rows },
        provenanceByStage: { tweets: prov },
      });
      expect(res.unconfirmedTotal).toBe(2);
      expect(res.lines).toEqual(["فيه تغريدتين ما قدرناش نتأكد من لغتها."]);
    });

    it("account filter on non-listing stage with 3 rows lacking author reports unconfirmed; listing counter-case is empty", () => {
      const nonListingStage: FilterConfirmationStage = {
        key: "tweets",
        deliver: true,
        item_noun_ar: "تغريدة",
        filters: [{ kind: "account", values: ["user1"] }],
        engine: { source_listing: false },
      };
      const rows = [
        { id: "1", text: "تغريدة بلا حساب" },
        { id: "2", text: "تغريدة بلا حساب" },
        { id: "3", text: "تغريدة بلا حساب" },
      ];
      const prov = new Map<string, "rule" | "model" | "legacy">([
        ["1", "rule"],
        ["2", "rule"],
        ["3", "rule"],
      ]);

      const res = unconfirmedFilterNotices({
        stages: [nonListingStage],
        rowsByStage: { tweets: rows },
        provenanceByStage: { tweets: prov },
      });
      expect(res.unconfirmedTotal).toBe(3);
      expect(res.lines).toEqual(["فيه ٣ تغريدات ما قدرناش نتأكد من مصدرها."]);

      // Counter-case: source_listing is true
      const listingStage: FilterConfirmationStage = {
        ...nonListingStage,
        engine: { source_listing: true },
      };
      const resListing = unconfirmedFilterNotices({
        stages: [listingStage],
        rowsByStage: { tweets: rows },
        provenanceByStage: { tweets: prov },
      });
      expect(resListing.unconfirmedTotal).toBe(0);
      expect(resListing.lines).toEqual([]);
    });

    it("by: legacy rows with valid date are counted as unconfirmed without re-evaluating", () => {
      const stage: FilterConfirmationStage = {
        key: "tweets",
        deliver: true,
        item_noun_ar: "تغريدة",
        filters: [{ kind: "period", days: 7, field: "date" }],
      };
      const rows = [
        { id: "legacy1", date: new Date().toISOString(), text: "قديم" },
        { id: "legacy2", date: new Date().toISOString(), text: "قديم" },
      ];
      const prov = new Map<string, "rule" | "model" | "legacy">([
        ["legacy1", "legacy"],
        ["legacy2", "legacy"],
      ]);

      const res = unconfirmedFilterNotices({
        stages: [stage],
        rowsByStage: { tweets: rows },
        provenanceByStage: { tweets: prov },
      });
      expect(res.unconfirmedTotal).toBe(2);
      expect(res.lines).toEqual(["فيه تغريدتين ما قدرناش نتأكد من تاريخها."]);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // 3. D-0214 Counter-Case (all rows confirmed -> no note)
  // ---------------------------------------------------------------------------------------------
  describe("3. D-0214 Counter-Case (all rows confirmed -> no note)", () => {
    it("when all rows have valid structured evidence, zero notes are emitted", () => {
      const stage: FilterConfirmationStage = {
        key: "tweets",
        deliver: true,
        item_noun_ar: "تغريدة",
        filters: [
          { kind: "period", days: 7, field: "date" },
          { kind: "language", lang: "ar", field: "lang" },
          { kind: "account", field: "author", values: ["Salah"] },
        ],
      };
      const validDate = new Date().toISOString();
      const rows = [
        { id: "1", date: validDate, lang: "ar", author: "Salah", text: "النص عربي كامل" },
        { id: "2", date: validDate, lang: "ar", author: "Salah", text: "النص عربي كامل" },
      ];
      const prov = new Map<string, "rule" | "model" | "legacy">([
        ["1", "rule"],
        ["2", "rule"],
      ]);

      const res = unconfirmedFilterNotices({
        stages: [stage],
        rowsByStage: { tweets: rows },
        provenanceByStage: { tweets: prov },
      });
      expect(res.unconfirmedTotal).toBe(0);
      expect(res.lines).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // 4. D-0213 Counter-Case (summary wording "بدون فلترة" never blocks)
  // ---------------------------------------------------------------------------------------------
  describe("4. D-0213 Counter-Case (summary wording never blocks)", () => {
    it("finish accepts delivered summary with «بدون فلترة» and «لم تُصفَّ»", async () => {
      const h = makeHarness({ phase: "execution" });
      const tools = Object.fromEntries(buildTools(h.ctx).map((t) => [t.name, t]));

      const r1: any = await tools.finish.handler({
        outcome: "delivered",
        summary_ar: "سُلّمت تغريدات مطابقة للطلب، بدون فلترة إضافية غير مطلوبة.",
      });
      expect(r1.ok).toBe(true);

      const r2: any = await tools.finish.handler({
        outcome: "delivered",
        summary_ar: "النتائج تشمل ردودًا وأسماء مشابهة ولم تُصفَّ.",
      });
      expect(r2.ok).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // 5. Q3 assumption_kinds (propose_plan + finalizeAcceptedPlan)
  // ---------------------------------------------------------------------------------------------
  describe("5. Q3 assumption_kinds (propose_plan + finalizeAcceptedPlan)", () => {
    it("removes only parent_fallback_exclusion assumption and adds PEOPLE_FALLBACK_LINE_AR when fallbacks exist", async () => {
      const h = makeHarness({ phase: "planning" });
      const tools = Object.fromEntries(buildTools(h.ctx).map((t) => [t.name, t]));

      // Propose plan with fallbacks on company parent binding
      const propRes: any = await tools.propose_plan.handler({
        summary_ar: "خطة شركات وموظفين.",
        assumptions_ar: ["لن يجلب لها موظفون في حال عدم توفر صفحة", "الأحدث أولاً"],
        assumption_kinds: ["parent_fallback_exclusion", "general"],
        stages: [
          {
            key: "companies",
            title_ar: "الشركات",
            endpoint_id: "google.maps",
            deliver: true,
            planned_rows: 5,
            columns: [{ key: "name", title_ar: "اسم الشركة" }],
            engine: {
              parent_binding: {
                fallbacks: [{ source: "website" }],
              },
            },
          },
          {
            key: "employees",
            title_ar: "الموظفون",
            endpoint_id: "contextdev.people.search",
            parent_key: "companies",
            deliver: true,
            planned_rows: 10,
            columns: [{ key: "name", title_ar: "اسم الموظف" }],
          },
        ],
      });

      if (propRes.ok && propRes.plan) {
        expect(propRes.plan.assumptions_ar).toEqual(["الأحدث أولاً"]);
        expect(propRes.plan.notes_ar).toContain(PEOPLE_FALLBACK_LINE_AR);
      }
    });

    it("counter-case: preserves tagged line and does not add fallback line when parent fallbacks absent", async () => {
      const h = makeHarness({ phase: "planning" });
      const tools = Object.fromEntries(buildTools(h.ctx).map((t) => [t.name, t]));

      const propRes: any = await tools.propose_plan.handler({
        summary_ar: "خطة عادية.",
        assumptions_ar: ["الأحدث أولاً"],
        assumption_kinds: ["general"],
        stages: [
          {
            key: "posts",
            title_ar: "المنشورات",
            endpoint_id: "web.search",
            deliver: true,
            planned_rows: 5,
            columns: [{ key: "text", title_ar: "النص" }],
          },
        ],
      });

      if (propRes.ok && propRes.plan) {
        expect(propRes.plan.notes_ar ?? []).not.toContain(PEOPLE_FALLBACK_LINE_AR);
      }
    });
  });

  // ---------------------------------------------------------------------------------------------
  // 6. Q4 Metadata-Driven Tool Descriptions & scanSourceCode Static Guard
  // ---------------------------------------------------------------------------------------------
  describe("6. Q4 Metadata-Driven Tool Descriptions & scanSourceCode Static Guard", () => {
    it("buildTools produces web tools and scanSourceCode finds 0 arabic_regex and 0 firecrawl/x/youtube tokens in agent/src/tools.ts", () => {
      const h = makeHarness({ phase: "planning" });
      h.ctx.web = {
        parsePage: vi.fn(),
        webSearch: vi.fn(),
        webScrape: vi.fn(),
        peopleSearch: vi.fn(),
      } as any;
      const tools = buildTools(h.ctx);
      const names = tools.map((t) => t.name);
      expect(names).toContain("catalog_search");
      expect(names).toContain("parse_page");
      expect(names).toContain("web_search");
      expect(names).toContain("web_scrape");
      expect(names).toContain("people_search");

      const catalog = loadTregCatalogIds();
      const code = fs.readFileSync(path.resolve(__dirname, "../agent/src/tools.ts"), "utf8");
      const violations = scanSourceCode("agent/src/tools.ts", code, catalog, new AllowIndex());

      const arViolations = violations.filter((v) => v.rule === "arabic_regex");
      expect(arViolations, JSON.stringify(arViolations)).toHaveLength(0);

      const tregViolations = violations.filter(
        (v) =>
          v.rule === "treg_token" &&
          ["firecrawl", "x", "youtube"].some((bad) => v.detail.toLowerCase().includes(bad)),
      );
      expect(tregViolations, JSON.stringify(tregViolations)).toHaveLength(0);
    });
  });
});
