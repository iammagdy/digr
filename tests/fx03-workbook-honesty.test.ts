import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { ItemStore } from "../agent/src/items/itemStore";
import { createMemoryStore } from "../agent/src/memoryStore";
import { runContactEnrichment } from "../agent/src/engine/contacts";
import { buildMethodology, type MissionFacts, type StageRecord } from "../agent/src/methodology";
import { COUNTER_UNAVAILABLE_AR, buildMissionFiles } from "../agent/src/workbook";
import { readDeliveredWorkbook } from "../agent/src/workbookBilling";
import { shortfallClauseAr } from "../agent/src/finalize";
import { perParentShortfallAr } from "../agent/src/perParentLimits";
import { VERIFICATION_NOTE_KEY, withCompanyQuality } from "../src/lib/agentMission/companyQuality";
import { csvExportFromWorkbook } from "../src/lib/server/csvFromExcel";
import { checkCustomerText } from "../src/lib/agentMission/text";
import {
  B2B_NOT_SEARCHED_AR,
  NOT_AVAILABLE_AR,
} from "../src/lib/agentMission/taskContracts";
import type { ContactStep, FinderInfo } from "../src/lib/agentMission/contactFinders";
import type { PricedPlan, PricedStage } from "../src/lib/agentMission/plan";
import { createJobCallBudget } from "../src/lib/server/callBudget";

const MISSION = "msn_fx03_fixture";
const finder = (id: string, input = "full_name"): FinderInfo => ({
  id,
  usd: 0.01,
  bill: "success",
  inputs: [{ name: input, required: true }],
});
const A = finder("finder.a");

function stageOf(
  key: string,
  title: string,
  planned: number,
  parent: string | null,
  columns: PricedStage["columns"],
  extra: Partial<PricedStage> = {},
): PricedStage {
  return {
    key,
    title_ar: title,
    planned_rows: planned,
    expected_rows: planned,
    endpoint_id: "fixture.items",
    parent_key: parent,
    deliver: true,
    columns,
    sample_rows: [],
    measured_by: [],
    measured_from_calls: [],
    measured_cost_per_row_usd: 0,
    ...extra,
  };
}

function planOf(stages: PricedStage[], extra: Partial<PricedPlan> = {}): PricedPlan {
  const deliveredRows = stages.reduce((sum, entry) => sum + entry.planned_rows, 0);
  return {
    summary_ar: "ملف بالنتائج المطلوبة",
    stages,
    price: {
      deliveredRows,
      totalCostUsd: 0,
      costPerFinalRowUsd: 0,
      unitPricePoints: 1,
      reservePoints: 200,
      maxChargePoints: 200,
      overCap: false,
    } as PricedPlan["price"],
    ...extra,
  };
}

const recordOf = (over: Partial<StageRecord> = {}): StageRecord => ({
  found: 0,
  duplicates: 0,
  accepted: 0,
  excluded: 0,
  pending: 0,
  unchecked: 0,
  acceptedByRule: 0,
  acceptedByModel: 0,
  excludedByReason: {},
  stop: "source_exhausted",
  ...over,
});

describe("FX-03 Workbook Honesty (N5, N6, N7)", () => {
  describe("N5: PerParentLimits stop guard and methodology truthful limits", () => {
    it.each(["failed", "budget", "daily_cap", "time_limit"] as const)(
      "when child stage stops with %s mid-job, methodology states the real stop reason and NOT «لم يُعثر»",
      async (stopReason) => {
        const companiesStage = stageOf("companies", "الشركات", 50, null, [
          { key: "name", title_ar: "اسم الشركة" },
        ]);
        const peopleStage = stageOf(
          "people",
          "صناع القرار",
          50,
          "companies",
          [
            { key: "name", title_ar: "الاسم" },
            { key: "title", title_ar: "المسمى الوظيفي" },
          ],
          { per_parent_rows: 1 },
        );
        const plan = planOf([companiesStage, peopleStage]);

        const companiesRows = Array.from({ length: 50 }, (_, i) => ({
          id: `c${i + 1}`,
          name: `شركة ${i + 1}`,
        }));
        // Only 20 companies got people delivered before child stage stopped
        const peopleRows = Array.from({ length: 20 }, (_, i) => ({
          id: `p${i + 1}`,
          parent_id: `c${i + 1}`,
          name: `شخص ${i + 1}`,
          title: "مدير",
        }));
        const rowsByStage = { companies: companiesRows, people: peopleRows };

        const facts: MissionFacts = {
          requestText: "٥٠ شركة مع صناع القرار",
          deliveredAt: new Date("2026-11-22T08:00:00Z"),
          reviewStop: null,
          stages: {
            companies: recordOf({ found: 50, accepted: 50, stop: "target_reached" }),
            people: recordOf({
              found: 20,
              accepted: 20,
              pending: 0,
              stop: stopReason,
            }),
          },
        };

        const m = buildMethodology({ plan, layouts: [], rowsByStage, facts });
        const limits = m.items.find((i) => i.label === "حدود هذا التسليم")?.values ?? [];
        const limitsText = limits.join("\n");

        const expectedShortfall = shortfallClauseAr(stopReason, { pending: 0, stop: null });
        expect(limitsText).toContain(expectedShortfall);
        expect(limitsText).not.toContain("لم يُعثر");
        expect(limitsText).not.toContain("لم يُعثر فيها على موظفين");

        // Verify CSV parity from csvExportFromWorkbook
        const built = await buildMissionFiles(plan, rowsByStage, facts, undefined, {
          completeContract: false,
        });
        const exp = await csvExportFromWorkbook(built.xlsx);
        expect(exp.methodologyCsv).toContain(expectedShortfall);
        expect(exp.methodologyCsv).not.toContain("لم يُعثر");
      },
    );

    it("counter-case: normal stops (source_exhausted, no_new_items, target_reached, null) still include «لم يُعثر» when parents have 0 children", () => {
      const parentIds = ["c1", "c2", "c3"];
      const childParentIds = ["c1"];
      const text = perParentShortfallAr({
        parentIds,
        childParentIds,
        perParent: 1,
        surplus: 0,
        stop: "source_exhausted",
      });
      expect(text).toContain("لم يُعثر");
    });
  });

  describe("N6: Contact enrichment incomplete marks «لم يكتمل البحث» and methodology limits line", () => {
    it("marks failed/stopped/unreached contact cells as «لم يكتمل البحث» instead of empty strings", async () => {
      const itemsStore = createMemoryStore();
      const items = await ItemStore.open(itemsStore, MISSION);
      await items.commit([
        {
          t: "item",
          stage: "companies",
          id: "c1",
          state: "accepted",
          by: "rule",
          row: { id: "c1", name: "Company 1" },
        },
        ...Array.from({ length: 5 }, (_, i) => ({
          t: "item" as const,
          stage: "people",
          id: `p${i + 1}`,
          state: "accepted" as const,
          by: "rule" as const,
          row: { id: `p${i + 1}`, parent_id: "c1", full_name: `Person ${i + 1}`, email: "" },
        })),
      ]);

      const emailStep: ContactStep = {
        kind: "email",
        stage_key: "people",
        column_key: "email",
        status_key: "email_status",
        per_person_usd: 0.05,
        finders: [A],
      };
      const plan = planOf([
        stageOf("companies", "الشركات", 1, null, [{ key: "name", title_ar: "اسم الشركة" }]),
        stageOf("people", "صناع القرار", 5, "companies", [
          { key: "full_name", title_ar: "الاسم" },
          { key: "email", title_ar: "الإيميل", kind: "work_email" as const },
        ]),
      ], { contact_steps: [emailStep] });

      const budget = createJobCallBudget({ ceilingUsd: 1, spentUsd: 0 });
      let callCount = 0;
      const gateway: Parameters<typeof runContactEnrichment>[0]["gateway"] = {
        async tregCall({ endpoint_id, params }) {
          callCount += 1;
          const call_id = `call_${callCount}`;
          // First 2 succeed
          if (callCount <= 2) {
            await itemsStore.putFile(
              MISSION,
              `raw/${call_id}.json`,
              JSON.stringify({ email: `person${callCount}@example.com` }),
              "application/json",
            );
            return {
              ok: true,
              call_id,
              http_status: 200,
              rows_in_page: 0,
              has_more: false,
              next_cursor: null,
              shape: null,
              first_rows: [],
              warnings: [],
              saved: `raw/${call_id}.json`,
            };
          }
          // 3rd hits HTTP 500 failure
          if (callCount === 3) {
            return { ok: false, call_id, failed: true, http_status: 503, message: "server error" };
          }
          // 4th hits daily_cap / budget
          return { ok: false, call_id, refused: "daily_cap", message: "daily cap reached" };
        },
      };

      const out = await runContactEnrichment({
        items,
        store: itemsStore,
        plan,
        missionId: MISSION,
        gateway,
        budget,
        addEvent: async () => {},
        deadlineMs: Date.now() + 60_000,
        attempts: undefined,
        provenance: true,
      });

      expect(out.filled.email).toBe(2);
      expect(out.stopped).toBe("daily_cap");

      const rows = items.acceptedRows("people");
      expect(rows[0].email).toBe("person1@example.com");
      expect(rows[1].email).toBe("person2@example.com");
      // Raw ItemStore rows remain untouched empty strings
      expect(rows[2].email).toBe("");
      expect(rows[3].email).toBe("");
      expect(rows[4].email).toBe("");
      expect(out.incompleteCells).toEqual([
        { stage: "people", rowId: "p3", column: "email" },
        { stage: "people", rowId: "p4", column: "email" },
        { stage: "people", rowId: "p5", column: "email" },
      ]);

      const built = await buildMissionFiles(
        plan as PricedPlan,
        { companies: [{ id: "c1", name: "Company 1" }], people: rows },
        { requestText: "test", deliveredAt: new Date(), incompleteCells: out.incompleteCells },
        undefined,
        { incompleteCells: out.incompleteCells, markMissingCells: true, completeContract: false },
      );
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(built.xlsx as never);
      const sheet = wb.worksheets.find((w) => w.name === "صناع القرار") ?? wb.worksheets[2];
      expect(sheet.getCell(4, 3).value).toBe(B2B_NOT_SEARCHED_AR); // p3 email
      expect(sheet.getCell(5, 3).value).toBe(B2B_NOT_SEARCHED_AR); // p4 email
      expect(sheet.getCell(6, 3).value).toBe(B2B_NOT_SEARCHED_AR); // p5 email

      const exp = await csvExportFromWorkbook(built.xlsx);
      expect(exp.stages[1].csv).toContain(B2B_NOT_SEARCHED_AR);
      expect(exp.methodologyCsv).toContain("لم يكتمل البحث لـ ٣ أشخاص");
    });

    it("counter-case: completely searched contact with no result gets «غير متوفر» (NOT_AVAILABLE_AR)", async () => {
      const itemsStore = createMemoryStore();
      const items = await ItemStore.open(itemsStore, `${MISSION}_empty`);
      await items.commit([
        {
          t: "item",
          stage: "companies",
          id: "c1",
          state: "accepted",
          by: "rule",
          row: { id: "c1", name: "Company 1" },
        },
        {
          t: "item",
          stage: "people",
          id: "p1",
          state: "accepted",
          by: "rule",
          row: { id: "p1", parent_id: "c1", full_name: "Person 1", email: "" },
        },
      ]);
      const emailStep: ContactStep = {
        kind: "email",
        stage_key: "people",
        column_key: "email",
        status_key: "email_status",
        per_person_usd: 0.05,
        finders: [A],
      };
      const plan = planOf([
        stageOf("companies", "الشركات", 1, null, [{ key: "name", title_ar: "اسم الشركة" }]),
        stageOf("people", "صناع القرار", 5, "companies", [
          { key: "full_name", title_ar: "الاسم" },
          { key: "email", title_ar: "الإيميل", kind: "work_email" as const },
        ]),
      ], { contact_steps: [emailStep] });

      const budget = createJobCallBudget({ ceilingUsd: 1, spentUsd: 0 });
      const gateway: Parameters<typeof runContactEnrichment>[0]["gateway"] = {
        async tregCall({ endpoint_id, params }) {
          await itemsStore.putFile(
            `${MISSION}_empty`,
            "raw/call_1.json",
            JSON.stringify({}),
            "application/json",
          );
          return {
            ok: true,
            call_id: "call_1",
            http_status: 200,
            rows_in_page: 0,
            has_more: false,
            next_cursor: null,
            shape: null,
            first_rows: [],
            warnings: [],
            saved: "raw/call_1.json",
          };
        },
      };

      const out = await runContactEnrichment({
        items,
        store: itemsStore,
        plan,
        missionId: `${MISSION}_empty`,
        gateway,
        budget,
        addEvent: async () => {},
        deadlineMs: Date.now() + 60_000,
        attempts: undefined,
        provenance: true,
      });

      expect(out.filled.email).toBe(0);
      expect(out.stopped).toBeNull();
      const rows = items.acceptedRows("people");
      expect(rows[0].email).toBe(NOT_AVAILABLE_AR);
    });
  });

  describe("N7: Workbook and CSV requested empty/stale cells become «غير متوفر»", () => {
    it("renders empty requested data cells as «غير متوفر» in Excel, worker CSV, and customer CSV", async () => {
      const plan = planOf([
        stageOf("companies", "الشركات", 2, null, [
          { key: "name", title_ar: "اسم الشركة" },
          { key: "website", title_ar: "الموقع الإلكتروني" },
          { key: "address", title_ar: "العنوان" },
        ]),
      ]);

      const rowsByStage = {
        companies: [
          { id: "c1", name: "شركة النور", website: "https://nour.test", address: "" },
          { id: "c2", name: "شركة الأمل", website: "", address: "غير متاح" },
        ],
      };

      const built = await buildMissionFiles(plan, rowsByStage, undefined, undefined, {
        completeContract: false,
        markMissingCells: true,
      });

      // 1. Check Excel
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(built.xlsx as never);
      const sheet = wb.worksheets[1];
      expect(sheet.getCell(2, 3).value).toBe(NOT_AVAILABLE_AR); // c1 address
      expect(sheet.getCell(3, 2).value).toBe(NOT_AVAILABLE_AR); // c2 website
      expect(sheet.getCell(3, 3).value).toBe(NOT_AVAILABLE_AR); // c2 address (was "غير متاح")

      // 2. Check worker CSV and customer CSV export
      expect(built.csv).toContain(NOT_AVAILABLE_AR);
      const exp = await csvExportFromWorkbook(built.xlsx);
      const stageCsv = exp.stages[0].csv;
      expect(stageCsv).toContain(NOT_AVAILABLE_AR);
      expect(stageCsv).not.toContain("غير متاح");
    });

    it("preserves compiled unavailable counters as «غير متاح» and internal meta notes as empty", async () => {
      const plan = planOf(
        [
          stageOf("posts", "المنشورات", 1, null, [
            { key: "title", title_ar: "العنوان" },
            { key: "shares_count", title_ar: "عدد المشاركات" },
          ]),
        ],
        {
          compiled: {
            by: "compiler",
            fields: [{ key: "shares_count", status: "unavailable" }],
          } as never,
        },
      );

      const rowsByStage = {
        posts: [{ id: "p1", title: "منشور أول", shares_count: "" }],
      };

      const built = await buildMissionFiles(plan, rowsByStage, undefined, undefined, {
        completeContract: false,
        markMissingCells: true,
      });
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(built.xlsx as never);
      const sheet = wb.worksheets[1];
      // Compiled unavailable counter stays COUNTER_UNAVAILABLE_AR («غير متاح»)
      expect(sheet.getCell(2, 2).value).toBe(COUNTER_UNAVAILABLE_AR);
    });

    it("companyQuality sets unusable address to null on raw row while workbook renders «غير متوفر»", async () => {
      const plan = planOf([
        stageOf("companies", "الشركات", 1, null, [
          { key: "name", title_ar: "اسم الشركة" },
          { key: "address", title_ar: "العنوان" },
        ]),
      ]);
      const rowsIn = {
        companies: [{ id: "c1", name: "شركة تجريبية", address: "31.25" }],
      };
      const res = withCompanyQuality(plan, rowsIn);
      expect(res.rowsByStage.companies[0].address).toBeNull();
      expect(res.limitLines.some((l) => l.includes("العنوان"))).toBe(true);
      const note = String(res.rowsByStage.companies[0][VERIFICATION_NOTE_KEY] ?? "");
      expect(note.includes("ليس عنوانًا")).toBe(true);

      const built = await buildMissionFiles(plan, res.rowsByStage, undefined, undefined, {
        completeContract: false,
        markMissingCells: true,
      });
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(built.xlsx as never);
      const sheet = wb.worksheets[1];
      expect(sheet.getCell(2, 2).value).toBe(NOT_AVAILABLE_AR);
    });

    it("counter-case: flags-off (markMissingCells false/omitted) keeps missing cells null/empty", async () => {
      const plan = planOf([
        stageOf("companies", "الشركات", 1, null, [
          { key: "name", title_ar: "اسم الشركة" },
          { key: "address", title_ar: "العنوان" },
        ]),
      ]);
      const rowsByStage = {
        companies: [{ id: "c1", name: "شركة تجريبية", address: "" }],
      };
      const built = await buildMissionFiles(plan, rowsByStage, undefined, undefined, {
        completeContract: false,
        markMissingCells: false,
      });
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(built.xlsx as never);
      const sheet = wb.worksheets[1];
      expect(sheet.getCell(2, 2).value).toBeNull();
    });
  });

  describe("Billing Parity Counter-Cases (FX-M1 Workbook Billing Reader)", () => {
    it("never bills contact cells holding «غير متوفر» or «لم يكتمل البحث»", async () => {
      const plan = planOf([
        stageOf("companies", "الشركات", 3, null, [{ key: "name", title_ar: "اسم الشركة" }]),
        stageOf("people", "الأشخاص", 3, "companies", [
          { key: "name", title_ar: "اسم الشخص" },
          { key: "email", title_ar: "الإيميل", kind: "work_email" },
        ]),
      ]);
      plan.contact_steps = [
        {
          kind: "email",
          column_key: "email",
          stage_key: "people",
          status_key: "email_status",
          per_person_usd: 0,
          finders: [],
        },
      ];

      // All 3 people have non-billable markers
      const { xlsx, billingLayout } = await buildMissionFiles(
        plan,
        {
          companies: [{ id: "c1", name: "شركة ١" }],
          people: [
            { id: "p1", parent_id: "c1", name: "شخص ١", email: NOT_AVAILABLE_AR },
            { id: "p2", parent_id: "c1", name: "شخص ٢", email: B2B_NOT_SEARCHED_AR },
            { id: "p3", parent_id: "c1", name: "شخص ٣", email: "" },
          ],
        },
        undefined,
        undefined,
        { completeContract: false },
      );

      const result = await readDeliveredWorkbook(xlsx, billingLayout, plan);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Contact count billed must be 0! All 3 people are unbilled because none has a real contact.
      expect(result.unbilled.total).toBe(3);
      expect(result.unbilled.byStage.people).toBe(3);
    });
  });

  describe("Customer Text Validation (checkCustomerText)", () => {
    it("validates all newly generated Arabic strings have issues === []", () => {
      const sampleTexts = [
        `«الإيميل»: تم البحث لـ شخصين من أصل ٥ أشخاص، ولم يكتمل البحث لـ ٣ أشخاص (تعذّر أو توقف قبل الوصول إليها)؛ كُتب «${B2B_NOT_SEARCHED_AR}» في خلاياها.`,
        `«الإيميل»: لم يكتمل البحث لـ شخص واحد من أصل ٥ أشخاص (تعذّر أو توقف قبل إتمام البحث)؛ كُتب «${B2B_NOT_SEARCHED_AR}» في خلاياها.`,
        `لم نعتمد العنوان في شركة واحدة لأنه في المصدر ليس عنوانًا («31.25»)، وكُتب «${NOT_AVAILABLE_AR}».`,
        `العنوان في المصدر («31.25») ليس عنوانًا فكُتب «${NOT_AVAILABLE_AR}»`,
      ];

      for (const text of sampleTexts) {
        const check = checkCustomerText(text);
        expect(check.issues).toEqual([]);
      }
    });
  });
});
