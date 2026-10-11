import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { acceptQuote } from "../src/functions/shared/quoteAccept";
import { calculateDependentPlanQuote, calculateDependentSettlement, DependentPlanStepSchema, runDependentPlanWithFakeTreg, validateDependentPlanSteps, type DependentPlanStep } from "../src/functions/shared/dependentPlans";
import { createAndSaveManagedQuote } from "../src/functions/shared/planManager";
import { ProposePlanSchema } from "../src/functions/shared/llmClient";
import { startFakeTregFixtureServer, type FakeTregFixtureServer } from "./fixtures/fakeTregServer";

const capabilities = [
  { slug: "fixture-account-discovery", unitCostUsd: 0.01, nameAr: "اكتشاف حسابات" },
  { slug: "fixture-account-videos", unitCostUsd: 0.002, nameAr: "مقاطع الحسابات" },
];

const influencerSteps: DependentPlanStep[] = [
  {
    stepId: "accounts",
    capabilitySlug: "fixture-account-discovery",
    params: { query: "مؤثرو تطوير الذات في مصر" },
    targetVolumeMin: 1,
    targetVolumeMax: 3,
    volumeMode: "bounded",
  },
  {
    stepId: "videos",
    capabilitySlug: "fixture-account-videos",
    params: { publishedAfter: "2026-07-10", publishedBefore: "2026-10-10" },
    targetVolumeMin: 1,
    targetVolumeMax: 3,
    dependsOn: ["accounts"],
    inputFrom: { stepId: "accounts", field: "username", paramKey: "username" },
    fanOutCap: 2,
    volumeMode: "open_ended",
    windowed: true,
  },
];

const windows = [
  { from: "2026-07-10", to: "2026-08-10" },
  { from: "2026-08-11", to: "2026-09-10" },
  { from: "2026-09-11", to: "2026-10-10" },
];

let activeServers: FakeTregFixtureServer[] = [];
async function fakeServer(options: { failUsers?: string[]; cursorLoop?: boolean } = {}) {
  const server = await startFakeTregFixtureServer(options);
  activeServers.push(server);
  return server;
}

afterEach(async () => {
  await Promise.all(activeServers.map((server) => server.close()));
  activeServers = [];
});

function mockQuoteTables() {
  const rows = new Map<string, any>();
  return {
    rows,
    async listRows({ tableId }: { tableId: string }) {
      return { total: 0, rows: [] };
    },
    async updateRow({ tableId, rowId, data }: { tableId: string; rowId: string; data: any }) {
      const key = `${tableId}:${rowId}`;
      const row = { ...(rows.get(key) || {}), ...data, $id: rowId };
      rows.set(key, row);
      return row;
    },
    async createRow({ tableId, rowId, data }: { tableId: string; rowId: string; data: any }) {
      const key = `${tableId}:${rowId}`;
      const row = { ...data, $id: rowId };
      rows.set(key, row);
      return row;
    },
  };
}

describe("dependent multi-step plans (fake data only)", () => {
  it("validates backward-only dependencies and requires a bounded fan-out and numeric cap", () => {
    expect(validateDependentPlanSteps(influencerSteps)).toMatchObject({ valid: true, dependent: true });
    expect(validateDependentPlanSteps([
      influencerSteps[0],
      { ...influencerSteps[1], dependsOn: ["missing"] },
    ]).valid).toBe(false);
    expect(validateDependentPlanSteps([
      influencerSteps[0],
      { ...influencerSteps[1], fanOutCap: undefined },
    ]).errors.some((error) => error.includes("سقف تفريع"))).toBe(true);
    expect(DependentPlanStepSchema.safeParse({ ...influencerSteps[1], targetVolumeMax: undefined }).success).toBe(false);
    expect(ProposePlanSchema.safeParse({
      type: "propose_plan",
      summaryAr: "خطة مفتوحة",
      capabilities: [{ ...influencerSteps[0], targetVolumeMax: undefined }],
    }).success).toBe(false);
  });

  it("quotes the sum of per-step upper bounds and persists the dependency graph", async () => {
    const quote = calculateDependentPlanQuote(influencerSteps, capabilities, 500);
    expect(quote.targetVolumeMax).toBe(9); // 3 accounts + up to 3 videos for each of 2 accounts.
    expect(quote.stepCostRanges.map((range) => range.maxUnits)).toEqual([3, 6]);
    expect(quote.quotedPoints).toBe(quote.stepCostRanges.reduce((sum, range) => sum + range.maxPoints, 0));
    expect(quote.isAffordable).toBe(true);

    const tables = mockQuoteTables();
    const saved = await createAndSaveManagedQuote(tables as any, {
      conversationId: "conv_e",
      userId: "user_e",
      plan: { summaryAr: "حسابات ثم مقاطع حتى سقف محدد", items: influencerSteps as any, outputFormats: ["xlsx", "csv"] },
      userBalance: 500,
      capabilities: capabilities.map((capability) => ({
        ...capability,
        category: "web",
        nameEn: capability.slug,
        descriptionAr: "بيانات تجريبية محلية",
        paramsSchema: "{}",
        tregEndpointId: "fixture-only",
        tregMethod: "POST" as const,
        pricingUnit: "item" as const,
        maxRows: 5000,
        paginationType: "cursor" as const,
        enabled: true,
      })) as any,
    });
    expect(saved.isDependent).toBe(true);
    expect(saved.targetVolumeMax).toBe(9);
    expect(saved.stepCostRanges).toHaveLength(2);
    const stored = [...tables.rows.values()][0];
    expect(stored.quotedPoints).toBe(saved.quotedPoints);
    expect(JSON.parse(stored.itemsJson).items[1].inputFrom).toEqual(influencerSteps[1].inputFrom);
  });

  it("executes the Egyptian self-development influencer scenario with capped fan-out, date windows and cross-step dedupe", async () => {
    const server = await fakeServer();
    const state = await runDependentPlanWithFakeTreg({ steps: influencerSteps, fetchPage: server.fetchPage, windows });
    expect(state.status).toBe("done");
    expect(state.outputs.accounts).toHaveLength(3);
    expect(state.steps.videos.inputRuns).toHaveLength(2); // The third discovered account is beyond fanOutCap.
    expect(state.outputs.videos).toHaveLength(6); // Shared video appears once even across two account branches.
    expect(new Set(state.outputs.videos.map((row) => row.videoId)).size).toBe(6);
    expect(new Set(server.requests.filter((request) => request.stepId === "videos").map((request) => request.window?.from)).size).toBe(3);
    expect(server.requests.every((request) => request.capabilitySlug.startsWith("fixture-"))).toBe(true);

    const quote = calculateDependentPlanQuote(influencerSteps, capabilities, 500);
    const settlement = calculateDependentSettlement(influencerSteps, quote.stepCostRanges, state, quote.quotedPoints);
    expect(settlement.deliveredUnits).toBe(9);
    expect(settlement.chargePoints).toBeLessThanOrEqual(quote.quotedPoints);
    expect(settlement.refundPoints).toBe(quote.quotedPoints - settlement.chargePoints);
    expect(settlement.stepDeliveredUnits).toEqual({ accounts: 3, videos: 6 });
  });

  it("keeps partial results when one fan-out branch fails", async () => {
    const server = await fakeServer({ failUsers: ["karim"] });
    const steps = influencerSteps.map((step) => step.stepId === "videos" ? { ...step, fanOutCap: 3 } : step);
    const state = await runDependentPlanWithFakeTreg({ steps, fetchPage: server.fetchPage, windows });
    expect(state.status).toBe("partial");
    expect(state.steps.videos.status).toBe("partial");
    expect(state.steps.videos.errorCodes).toContain("fixture_branch_failure");
    expect(state.outputs.videos.length).toBeGreaterThan(0);
    expect(state.steps.videos.inputRuns.find((run) => run.key === "karim")?.failed).toBe(true);
  });

  it("cancels cleanly and resumes without repeating a completed discovery step", async () => {
    const server = await fakeServer();
    const first = await runDependentPlanWithFakeTreg({
      steps: influencerSteps,
      fetchPage: server.fetchPage,
      shouldCancel: () => server.requests.some((request) => request.stepId === "accounts"),
    });
    expect(first.status).toBe("cancelled");
    expect(first.steps.accounts.status).toBe("done");
    const accountCallsBeforeResume = server.requests.filter((request) => request.stepId === "accounts").length;
    const resumed = await runDependentPlanWithFakeTreg({ steps: influencerSteps, fetchPage: server.fetchPage, state: first, shouldCancel: () => false });
    expect(resumed.status).toBe("done");
    expect(server.requests.filter((request) => request.stepId === "accounts")).toHaveLength(accountCallsBeforeResume);
  });

  it("resumes cursor pagination after a bounded page slice and rejects state from a changed plan", async () => {
    const server = await fakeServer();
    const first = await runDependentPlanWithFakeTreg({ steps: influencerSteps, fetchPage: server.fetchPage, maxPagesPerInput: 1 });
    expect(first.status).toBe("partial");
    const resumed = await runDependentPlanWithFakeTreg({ steps: influencerSteps, fetchPage: server.fetchPage, state: first, maxPagesPerInput: 20 });
    expect(resumed.status).toBe("done");
    expect(server.requests.filter((request) => request.stepId === "accounts")).toHaveLength(1);
    await expect(runDependentPlanWithFakeTreg({ steps: influencerSteps.map((step) => ({ ...step, targetVolumeMax: step.targetVolumeMax + 1 })), fetchPage: server.fetchPage, state: first })).rejects.toThrow("الخطة تغيرت");
  });

  it("detects repeated cursors and stops instead of looping forever", async () => {
    const server = await fakeServer({ cursorLoop: true });
    const loopPlan: DependentPlanStep[] = [
      { ...influencerSteps[0], params: { mode: "cursor_loop" }, targetVolumeMax: 2 },
      { ...influencerSteps[1], fanOutCap: 1 },
    ];
    const state = await runDependentPlanWithFakeTreg({ steps: loopPlan, fetchPage: server.fetchPage });
    expect(state.status).toBe("partial");
    expect(state.steps.accounts.errorCodes).toContain("cursor_loop");
    expect(server.requests.filter((request) => request.stepId === "accounts")).toHaveLength(2);
  });

  it("keeps a hard total-page ceiling across repeated resumptions", async () => {
    const steps: DependentPlanStep[] = [
      { stepId: "accounts", capabilitySlug: "fixture-account-discovery", params: {}, targetVolumeMin: 1, targetVolumeMax: 2 },
      { stepId: "videos", capabilitySlug: "fixture-account-videos", params: {}, targetVolumeMin: 1, targetVolumeMax: 1, dependsOn: ["accounts"], inputFrom: { stepId: "accounts", field: "username", paramKey: "username" }, fanOutCap: 1 },
    ];
    let pageCount = 0;
    const fetchPage = async () => {
      pageCount += 1;
      return { ok: true, rows: [], nextCursor: `cursor-${pageCount}` };
    };
    let state = await runDependentPlanWithFakeTreg({ steps, fetchPage, maxPagesPerInput: 100 });
    for (let resume = 1; resume < 10; resume += 1) {
      state = await runDependentPlanWithFakeTreg({ steps, fetchPage, state, maxPagesPerInput: 100 });
    }
    expect(pageCount).toBe(1_000);
    const capped = await runDependentPlanWithFakeTreg({ steps, fetchPage, state, maxPagesPerInput: 100 });
    expect(pageCount).toBe(1_000);
    expect(capped.steps.accounts.errorCodes).toContain("plan_page_cap");
  });

  it("does not reserve points for dependent plans on the production single-step acceptance path", async () => {
    let laterReadCount = 0;
    const futureQuote = {
      $id: "quote_dependent",
      userId: "owner_test",
      status: "proposed",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      summaryAr: "اختبار متعدد الخطوات",
      quotedPoints: 100,
      itemsJson: JSON.stringify({ version: 1, items: influencerSteps, outputFormats: ["xlsx"] }),
    };
    const result = await acceptQuote({
      async getRow() { return futureQuote; },
      async listRows() { laterReadCount += 1; throw new Error("should not read balances or jobs"); },
    } as any, { userId: "owner_test", quoteId: "quote_dependent" });
    expect(result.success).toBe(false);
    expect(result.statusCode).toBe(503);
    expect(laterReadCount).toBe(0);
    const card = readFileSync("src/app/dashboard/chat/components/PlanQuoteCard.tsx", "utf8");
    expect(card).toContain("quote.isDependent");
    expect(card).toContain("التنفيذ الفعلي غير مفعّل حالياً");
    expect(card).toContain("حتى {quote.targetVolumeMax");
    // The start button also disables on quote expiry — strictly stronger than dependent-only.
    expect(card).toContain("disabled={isStarting || !quote.isAffordable || quote.isDependent || expired}");
  });
});
