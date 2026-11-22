import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadTregCatalog, type CatalogEndpoint } from "../src/lib/treg/catalog";
import { validatePlan, isChildEntity, type StepSample, type ValidateContext } from "../src/lib/modelPlanner/validate";
import { runMissionChunk, BARREN_PAGES_LIMIT } from "../src/lib/modelPlanner/missionEngine";
import { customerMissionView } from "../src/lib/agentMission/customerView";
import { AgentMissionCardBody } from "../src/components/mission/AgentMissionCard";
import { checkCustomerText } from "../src/lib/agentMission/text";
import { ProposePlanSchema, type ProposePlanInput, type StoredModelPlan } from "../src/lib/modelPlanner/types";
import { buildShapeDigest } from "../src/lib/modelPlanner/digest";
import type { InterpreterDeps } from "../src/lib/modelPlanner/stageCall";

const catalog = loadTregCatalog();
const TODAY = new Date("2026-11-22T12:00:00Z");

// Real samples from live mission msn_a3cb50bacff4aadf3b70
const REAL_TOMBA_COMPANIES = [
  { id: "co_1", name: "ITWorx", domain: "itworx.com", website: "https://itworx.com", city: "Cairo", country: "EG" },
  { id: "co_2", name: "Instabug", domain: "instabug.com", website: "https://instabug.com", city: "Cairo", country: "EG" },
  { id: "co_3", name: "Robusta Studio", domain: "robusta.studio", website: "https://robusta.studio", city: "Cairo", country: "EG" },
];

const REAL_LEADMAGIC_EMPLOYEES: Record<string, Array<Record<string, unknown>>> = {
  "itworx.com": [{ id: "emp_1", full_name: "Youssef Ahmed", title: "Marketing Director", company_name: "ITWorx", company_domain: "itworx.com" }],
  "instabug.com": [{ id: "emp_2", full_name: "Mariam Hassan", title: "Head of Marketing", company_name: "Instabug", company_domain: "instabug.com" }],
  "robusta.studio": [{ id: "emp_3", full_name: "Karim Tarek", title: "Marketing Lead", company_name: "Robusta Studio", company_domain: "robusta.studio" }],
};

const sampleOf = (endpointId: string, rows: Array<Record<string, unknown>>): StepSample => {
  const ep = catalog.byId.get(endpointId)!;
  return { endpointId, rows, digest: buildShapeDigest({ rows }, ep).digest, costUsd: 0.001 };
};

const makeContext = (samples: StepSample[] = []): ValidateContext => ({
  customerText: "مدير تسويق من كل شركة من ٣ شركات برمجيات في القاهرة",
  access: { isAdmin: false, verifiedBusiness: false },
  catalog,
  samples: new Map(samples.map((s) => [s.endpointId, s])),
  today: TODAY,
});

describe("DT-20261122-people-binding Live Replay & Fixes Verification", () => {
  describe("Fix 1: validatePlan Enforces Parent Binding on Per-Parent & Child Entity Steps", () => {
    it("helper isChildEntity uses catalog metadata only without word lists or provider names", () => {
      const companiesEp = catalog.byId.get("tomba.companies.search.reveal")!;
      const peopleEp = catalog.byId.get("blitzapi.people.search")!;
      const leadmagicEp = catalog.byId.get("leadmagic.x.employee-finder")!;
      const xEp = catalog.byId.get("anyapi.x.user.posts");

      expect(isChildEntity(peopleEp, companiesEp)).toBe(true);
      expect(isChildEntity(leadmagicEp, companiesEp)).toBe(true);
      expect(isChildEntity(companiesEp, peopleEp)).toBe(false);
      expect(isChildEntity(xEp, companiesEp)).toBe(false);
      expect(isChildEntity(undefined, companiesEp)).toBe(false);
    });

    it("REPLAY A: Original mission plan with unbound people step fails validation with missing_parent_binding", () => {
      const tombaSample = sampleOf("tomba.companies.search.reveal", REAL_TOMBA_COMPANIES);
      const blitzSample = sampleOf("blitzapi.people.search", [{ first_name: "Alex", last_name: "Test", headline: "Marketing Manager" }]);
      const ctx = makeContext([tombaSample, blitzSample]);

      // The exact unbound plan from live mission msn_a3cb50bacff4aadf3b70
      const unboundPlan: ProposePlanInput = ProposePlanSchema.parse({
        summaryAr: "جمع مدير تسويق من ٣ شركات برمجيات في القاهرة",
        steps: [
          {
            endpointId: "tomba.companies.search.reveal",
            titleAr: "شركات البرمجيات في القاهرة",
            volume: 3,
            deliver: true,
            params: [
              { name: "query", value: "software", source: "literal" },
            ],
            fieldMap: {
              columns: [
                { field: "name", headerAr: "اسم الشركة", role: "company" },
                { field: "domain", headerAr: "النطاق", role: "website" },
              ],
              pagination: { kind: "single" },
            },
            filters: [],
          },
          {
            endpointId: "blitzapi.people.search",
            titleAr: "مدير تسويق في كل شركة",
            volume: 3,
            perItem: 1, // Marked as perItem but NO prior_step param!
            deliver: true,
            params: [
              { name: "max_results", value: 10, source: "literal" },
            ],
            fieldMap: {
              columns: [
                { field: "full_name", headerAr: "الاسم", role: "author_name" },
                { field: "headline", headerAr: "المسمى الوظيفي", role: "job_title" },
              ],
              pagination: { kind: "token", param: "cursor" },
            },
            filters: [],
          },
        ],
      });

      const validation = validatePlan(unboundPlan, ctx);
      expect(validation.ok).toBe(false);
      if (validation.ok) {
        throw new Error("expected validation to fail");
      }
      expect(validation.issues.some((i) => i.code === "missing_parent_binding")).toBe(true);
      const missingBindingIssue = validation.issues.find((i) => i.code === "missing_parent_binding")!;
      expect(missingBindingIssue.stepIndex).toBe(1);
      expect(missingBindingIssue.message).toContain("is a per-parent step but has no parameter bound to a prior step");
    });

    it("COUNTER-CASE A: Independent multi-root plans without perItem or parent entity relationship remain valid", () => {
      const tombaSample = sampleOf("tomba.companies.search.reveal", REAL_TOMBA_COMPANIES);
      const ctx = makeContext([tombaSample]);

      // Two independent company root steps
      const independentPlan: ProposePlanInput = ProposePlanSchema.parse({
        summaryAr: "جمع شركات البرمجيات وشركات الاستشارات",
        steps: [
          {
            endpointId: "tomba.companies.search.reveal",
            titleAr: "شركات البرمجيات",
            volume: 3,
            deliver: true,
            params: [{ name: "query", value: "software", source: "literal" }],
            fieldMap: {
              columns: [{ field: "name", headerAr: "اسم الشركة", role: "company" }],
              pagination: { kind: "single" },
            },
            filters: [],
          },
          {
            endpointId: "tomba.companies.search.reveal",
            titleAr: "شركات الاستشارات",
            volume: 3,
            deliver: true,
            params: [{ name: "query", value: "consulting", source: "literal" }],
            fieldMap: {
              columns: [{ field: "name", headerAr: "اسم الشركة", role: "company" }],
              pagination: { kind: "single" },
            },
            filters: [],
          },
        ],
      });

      const validation = validatePlan(independentPlan, ctx);
      if (!validation.ok) {
        expect(validation.issues.some((i) => i.code === "missing_parent_binding")).toBe(false);
      } else {
        expect(validation.ok).toBe(true);
      }
    });
  });

  describe("Fix 1 & Pipeline: Bound Plan with leadmagic.x.employee-finder Maps 1 Person Per Company", () => {
    it("REPLAY B: Properly bound people step passes validation and maps 1 person per company in execution", async () => {
      const tombaSample = sampleOf("tomba.companies.search.reveal", REAL_TOMBA_COMPANIES);
      const leadmagicSample = sampleOf("leadmagic.x.employee-finder", REAL_LEADMAGIC_EMPLOYEES["itworx.com"]);
      const ctx = makeContext([tombaSample, leadmagicSample]);

      const boundPlanInput: ProposePlanInput = ProposePlanSchema.parse({
        summaryAr: "جمع مدير تسويق من ٣ شركات برمجيات في القاهرة",
        steps: [
          {
            endpointId: "tomba.companies.search.reveal",
            titleAr: "شركات البرمجيات في القاهرة",
            volume: 3,
            deliver: true,
            params: [
              { name: "query", value: "software", source: "literal" },
            ],
            fieldMap: {
              columns: [
                { field: "name", headerAr: "اسم الشركة", role: "company" },
                { field: "domain", headerAr: "النطاق", role: "website" },
              ],
              pagination: { kind: "single" },
            },
            filters: [],
          },
          {
            endpointId: "leadmagic.x.employee-finder",
            titleAr: "مدير تسويق في كل شركة",
            volume: 3,
            perItem: 1,
            deliver: true,
            params: [
              { name: "company_domain", source: "prior_step", fromStep: { step: 1, field: "domain" } },
              { name: "limit", value: 1, source: "literal" },
            ],
            fieldMap: {
              columns: [
                { field: "full_name", headerAr: "الاسم", role: "author_name" },
                { field: "title", headerAr: "المسمى الوظيفي", role: "job_title" },
                { field: "company_domain", headerAr: "نطاق الشركة", role: "website" },
              ],
              pagination: { kind: "single" },
            },
            filters: [],
          },
        ],
      });

      const validation = validatePlan(boundPlanInput, ctx);
      expect(validation.ok).toBe(true);
      if (!validation.ok) {
        throw new Error(`expected validation to pass: ${JSON.stringify(validation.issues)}`);
      }
      expect(validation.plan).toBeDefined();

      const stored = validation.plan.stored as StoredModelPlan;
      expect(stored.stages![1].parent).toBe(0);
      expect(stored.stages![1].perParent).toBe(1);

      let callCount = 0;
      const deps: InterpreterDeps = {
        call: async (options) => {
          callCount += 1;
          if (options.endpointId === "tomba.companies.search.reveal") {
            return {
              ok: true,
              httpStatus: 200,
              tregCallId: "call_tomba",
              costMicro: 1000,
              latencyMs: 50,
              data: { data: { companies: REAL_TOMBA_COMPANIES } },
              error: undefined,
              isRouteMaxCost: false,
              isPlatformBalanceLow: false,
            };
          }
          if (options.endpointId === "leadmagic.x.employee-finder") {
            const domain = String(options.params?.company_domain ?? "");
            const employees = REAL_LEADMAGIC_EMPLOYEES[domain] ?? [];
            return {
              ok: true,
              httpStatus: 200,
              tregCallId: `call_leadmagic_${domain}`,
              costMicro: 1250,
              latencyMs: 50,
              data: { data: employees },
              error: undefined,
              isRouteMaxCost: false,
              isPlatformBalanceLow: false,
            };
          }
          throw new Error("unexpected endpoint " + options.endpointId);
        },
      };

      const outChunk1 = await runMissionChunk(
        { jobId: "job_test", deadlineMs: Date.now() + 60_000, targetVolumeMax: 6, cursor: null } as any,
        stored,
        deps
      );

      // Verify that chunk 1 ran
      expect(outChunk1.ok).toBe(true);
      expect(outChunk1.nextCursor).not.toBeNull();

      // Chunk 2: executes stage 1 (people) for the companies
      const outChunk2 = await runMissionChunk(
        { jobId: "job_test", deadlineMs: Date.now() + 60_000, targetVolumeMax: 6, cursor: outChunk1.nextCursor } as any,
        stored,
        deps
      );

      expect(outChunk2.ok).toBe(true);
      const allRows = [...outChunk1.rows, ...outChunk2.rows];
      const peopleRows = allRows.filter((r: any) => r.author_name);
      // Total 3 people delivered across chunks (1 per company)
      expect(peopleRows.length).toBe(3);
      expect(peopleRows.map((r: any) => r.author_name)).toEqual([
        "Youssef Ahmed",
        "Mariam Hassan",
        "Karim Tarek",
      ]);
      // Each person is tagged with the parent company's id
      expect(peopleRows.map((r: any) => r.mission_parent_id)).toEqual(["s1-1", "s1-2", "s1-3"]);
    });
  });

  describe("Fix 2: BARREN_PAGES_LIMIT=3 Consecutive Zero-Match Pages Halts Runaway Pagination", () => {
    it("REPLAY C: Root stage returning 1 row per page but 0 matches stops after exactly 3 barren pages", async () => {
      expect(BARREN_PAGES_LIMIT).toBe(3);

      const singleStepPlan: StoredModelPlan = {
        v: 1,
        topic: "مدير تسويق في شركات برمجيات",
        steps: [
          {
            endpointId: "blitzapi.people.search",
            titleAr: "البحث عن الأشخاص",
            volume: 10,
            params: [{ name: "max_results", value: 1, source: "literal" }],
            fieldMap: {
              columns: [{ field: "full_name", headerAr: "الاسم", role: "author_name" }],
              pagination: { kind: "token", param: "cursor" },
            },
            filters: [],
            facts: {
              endpointId: "blitzapi.people.search",
              columns: [{ field: "full_name", role: "author_name" }],
              listPath: "results",
              cursorPath: "cursor",
              callEstimateUsd: 0.001,
              entity: "person",
            } as any,
          },
        ] as any,
        stages: [
          { parent: null, deliver: true, effVolume: 10, perParent: 0, titleAr: "البحث عن الأشخاص" },
        ],
      } as any;

      let callCount = 0;
      const deps: InterpreterDeps = {
        call: async () => {
          callCount += 1;
          const dummyRow = { full_name: `Random Person ${callCount}`, headline: "Chef at Restaurant" };
          return {
            ok: true,
            httpStatus: 200,
            tregCallId: `call_blitz_${callCount}`,
            costMicro: 495,
            latencyMs: 50,
            data: { results: [dummyRow], cursor: `cursor_page_${callCount + 1}` },
            error: undefined,
            isRouteMaxCost: false,
            isPlatformBalanceLow: false,
          };
        },
        advisor: async (input) => ({
          verdicts: new Map(input.rows.map((r) => [r.index, { verdict: "no_match", reasonAr: "غير مطابق للموضوع" }])),
          usage: { costUsd: 0.0001, inputTokens: 10, outputTokens: 10, model: "test-model", latencyMs: 5 },
        }),
      };

      const out = await runMissionChunk(
        { jobId: "job_barren_test", deadlineMs: Date.now() + 60_000, targetVolumeMax: 10, cursor: null } as any,
        singleStepPlan,
        deps
      );

      // Pagination must halt after exactly 3 pages, NOT 313 pages!
      expect(callCount).toBe(3);
      expect(out.ok).toBe(false);
      expect(out.rows.length).toBe(0);
      expect(out.errorCode).toBe("mission_stopped");
      expect(out.errorMessageAr).toContain("توقفت مرحلة الجمع بعد توالي صفحات دون نتائج تطابق موضوع البحث.");
    });

    it("COUNTER-CASE C: Sparse matches reset barrenPages and allow valid pagination to continue", async () => {
      const singleStepPlan: StoredModelPlan = {
        v: 1,
        topic: "مدير تسويق في شركات برمجيات",
        steps: [
          {
            endpointId: "blitzapi.people.search",
            titleAr: "البحث عن الأشخاص",
            volume: 10,
            params: [{ name: "max_results", value: 1, source: "literal" }],
            fieldMap: {
              columns: [{ field: "full_name", headerAr: "الاسم", role: "author_name" }],
              pagination: { kind: "token", param: "cursor" },
            },
            filters: [],
            facts: {
              endpointId: "blitzapi.people.search",
              columns: [{ field: "full_name", role: "author_name" }],
              listPath: "results",
              cursorPath: "cursor",
              callEstimateUsd: 0.001,
              entity: "person",
            } as any,
          },
        ] as any,
        stages: [
          { parent: null, deliver: true, effVolume: 10, perParent: 0, titleAr: "البحث عن الأشخاص" },
        ],
      } as any;

      let callCount = 0;
      const deps: InterpreterDeps = {
        call: async () => {
          callCount += 1;
          const dummyRow = { full_name: `Person ${callCount}`, headline: "Marketing Director" };
          return {
            ok: true,
            httpStatus: 200,
            tregCallId: `call_blitz_${callCount}`,
            costMicro: 495,
            latencyMs: 50,
            data: { results: [dummyRow], cursor: `cursor_page_${callCount + 1}` },
            error: undefined,
            isRouteMaxCost: false,
            isPlatformBalanceLow: false,
          };
        },
        advisor: async (input) => {
          const match = callCount === 2 || callCount === 4;
          return {
            verdicts: new Map(input.rows.map((r) => [r.index, { verdict: match ? "match" : "no_match", reasonAr: match ? "مطابق" : "غير مطابق" }])),
            usage: { costUsd: 0.0001, inputTokens: 10, outputTokens: 10, model: "test-model", latencyMs: 5 },
          };
        },
      };

      const out1 = await runMissionChunk(
        { jobId: "job_sparse_test", deadlineMs: Date.now() + 60_000, targetVolumeMax: 2, cursor: null } as any,
        singleStepPlan,
        deps
      );

      // In chunk 1: 3 calls were made, page 2 matched, resetting barrenPages, so chunk did NOT stop
      expect(out1.ok).toBe(true);
      expect(out1.nextCursor).not.toBeNull();
      expect(out1.missionProgress?.stages[0].stopped).toBeUndefined();

      // Chunk 2 continues pagination: call 4 matches and reaches target volume
      const out2 = await runMissionChunk(
        { jobId: "job_sparse_test", deadlineMs: Date.now() + 60_000, targetVolumeMax: 2, remainingNeeded: 1, cursor: out1.nextCursor } as any,
        singleStepPlan,
        deps
      );

      expect(out2.ok).toBe(true);
      expect(callCount).toBe(4);
      expect([...out1.rows, ...out2.rows].length).toBe(2);
      expect(out2.missionProgress?.stages[0].stopped).toBeUndefined();
    });
  });

  describe("Fix 3: Honest Reason on Partial Mission Card", () => {
    const html = (view: ReturnType<typeof customerMissionView>) =>
      renderToStaticMarkup(createElement(AgentMissionCardBody, { view, isGuest: false }));

    it("REPLAY D: Mission in partial phase displays honest reason on AgentMissionCard", () => {
      const view = customerMissionView({
        mission: {
          id: "msn_a3cb50bacff4aadf3b70",
          status: "completed", // Partial delivery (3 delivered out of 6 requested)
          summary_ar: null,
          delivered_units: 3,
          charged_points: 75,
          reserved_points: 150,
          created_at: new Date().toISOString(),
          files: [{ name: "companies.xlsx", kind: "sheet" }],
          plan_public: {
            stages: [
              { n: 1, title_ar: "شركات البرمجيات", deliver: true, expected_rows: 3 },
              { n: 2, title_ar: "مديرو التسويق", deliver: true, expected_rows: 3 },
            ],
            quantity: { requested: 6, target: 6 },
          },
        } as any,
        events: [
          {
            id: 1,
            kind: "mission_note",
            message_ar: JSON.stringify({
              kind: "stage_stopped",
              stage: 2,
              textAr: "توقفت مرحلة جمع الأشخاص قبل استكمال العدد لعدم تطابق النتائج",
            }),
            counts: { stage_1_rows: 3, stage_2_rows: 0 },
            created_at: new Date().toISOString(),
          },
        ],
      });

      expect(view.phase).toBe("partial");
      expect(view.partialReasonAr).toContain("اكتمل الجمع بعدد أقل من المطلوب: توقفت مرحلة جمع الأشخاص قبل استكمال العدد لعدم تطابق النتائج.");

      // Check text passes customerText rules
      const check = checkCustomerText(view.partialReasonAr!);
      expect(check.issues).toEqual([]);

      const rendered = html(view);
      expect(rendered).toContain('data-testid="agent-partial-reason"');
      expect(rendered).toContain("توقفت مرحلة جمع الأشخاص قبل استكمال العدد");
    });

    it("REPLAY D FALLBACK: When no note exists, fallback Arabic explanation is displayed", () => {
      const view = customerMissionView({
        mission: {
          id: "msn_fallback_partial",
          status: "completed",
          summary_ar: null,
          delivered_units: 3,
          charged_points: 75,
          reserved_points: 150,
          created_at: new Date().toISOString(),
          files: [{ name: "companies.xlsx", kind: "sheet" }],
          plan_public: {
            stages: [{ n: 1, title_ar: "الشركات", deliver: true, expected_rows: 3 }, { n: 2, title_ar: "الأشخاص", deliver: true, expected_rows: 3 }],
            quantity: { requested: 6, target: 6 },
          },
        } as any,
        events: [], // No events
      });

      expect(view.phase).toBe("partial");
      expect(view.partialReasonAr).toContain("اكتمل الجمع بعدد أقل من المطلوب: توقفت إحدى مراحل الجمع قبل استكمال العدد المطلوب بسبب استهلاك الحد المالي المخصص للطلب.");

      const check = checkCustomerText(view.partialReasonAr!);
      expect(check.issues).toEqual([]);

      const rendered = html(view);
      expect(rendered).toContain('data-testid="agent-partial-reason"');
      expect(rendered).toContain("توقفت إحدى مراحل الجمع قبل استكمال العدد المطلوب");
    });

    it("COUNTER-CASE D: Hallucinated numbers claiming > realDelivered or > realCharged remain blocked", () => {
      const view = customerMissionView({
        mission: {
          id: "msn_hallucinated_partial",
          status: "completed",
          summary_ar: "تم تسليم 10 شركات بخصم 200 نقطة.", // Claims 10 delivered when real is 3, claims 200 charged when real is 75
          delivered_units: 3,
          charged_points: 75,
          reserved_points: 150,
          created_at: new Date().toISOString(),
          files: [{ name: "companies.xlsx", kind: "sheet" }],
          plan_public: {
            stages: [{ n: 1, title_ar: "الشركات", deliver: true, expected_rows: 3 }, { n: 2, title_ar: "الأشخاص", deliver: true, expected_rows: 3 }],
            quantity: { requested: 6, target: 6 },
          },
        } as any,
        events: [],
      });

      expect(view.phase).toBe("partial");
      // Hallucinated summary is rejected
      expect(view.resultSummaryAr).toBeNull();
      // Uses safe fallback
      expect(view.partialReasonAr).toBe("اكتمل الجمع بعدد أقل من المطلوب: توقفت إحدى مراحل الجمع قبل استكمال العدد المطلوب بسبب استهلاك الحد المالي المخصص للطلب.");
    });
  });
});
