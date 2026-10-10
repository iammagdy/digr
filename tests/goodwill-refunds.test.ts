import { afterEach, describe, expect, it } from "vitest";
import { Query, TablesDB } from "node-appwrite";
import { applyGoodwillOutcome, decideGoodwillRefund, parseGoodwillPolicy, saveCustomerComplaint } from "../src/functions/shared/goodwillRefund";
import { createGoodwillAdjustment } from "../src/functions/shared/ledger";
import type { RunFacts } from "../src/functions/shared/resultReview";

class FakeTables {
  rows = new Map<string, Record<string, any>>();
  unavailable = false;

  private key(tableId: string, rowId: string) { return `${tableId}:${rowId}`; }

  async getRow({ tableId, rowId }: { tableId: string; rowId: string }) {
    const row = this.rows.get(this.key(tableId, rowId));
    if (!row) throw { code: 404 };
    return row;
  }

  async createRow({ tableId, rowId, data, permissions }: { tableId: string; rowId: string; data: Record<string, any>; permissions?: string[] }) {
    if (this.unavailable && tableId === "notifications") throw { code: 404 };
    const key = this.key(tableId, rowId);
    if (this.rows.has(key)) throw { code: 409 };
    const row = { $id: rowId, ...data, permissions };
    this.rows.set(key, row);
    return row;
  }

  async updateRow({ tableId, rowId, data }: { tableId: string; rowId: string; data: Record<string, any> }) {
    const key = this.key(tableId, rowId);
    const current = this.rows.get(key);
    if (!current) throw { code: 404 };
    const updated = { ...current, ...data };
    this.rows.set(key, updated);
    return updated;
  }

  async listRows({ tableId, queries = [] }: { tableId: string; queries?: string[] }) {
    if (this.unavailable && tableId === "notifications") throw { code: 404 };
    const constraints = queries.map((query) => { try { return JSON.parse(query); } catch { return null; } }).filter(Boolean);
    let rows = [...this.rows.entries()].filter(([key]) => key.startsWith(`${tableId}:`)).map(([, row]) => row);
    for (const query of constraints) {
      if (query.method === "equal") rows = rows.filter((row) => query.values.includes(row[query.attribute]));
    }
    const offset = Number(constraints.find((query) => query.method === "offset")?.values?.[0]) || 0;
    const limit = Number(constraints.find((query) => query.method === "limit")?.values?.[0]) || 100;
    return { rows: rows.slice(offset, offset + limit) };
  }
}

const fakeFacts = (finding: { code: string; severity: "critical" | "warning" | "info"; textAr: string }, overrides: Partial<RunFacts> = {}): RunFacts => ({
  requested: { min: 10, max: 20 },
  delivered: 10,
  rowsPerSource: [], rowsPerWindow: [], dayByDayCoverage: [], duplicateCount: 0,
  replyCount: 0, replyShare: 0, conversationsWithMultipleItems: 0, languageShares: [],
  emptyWindows: [], failedWindows: [], observedDateRange: { from: null, to: null }, unrelatedShare: null,
  findings: [{ ...finding, evidence: {} }], samples: [], severity: finding.severity,
  ...overrides,
});

function asTables(fake: FakeTables) { return fake as unknown as TablesDB; }
const originalFlag = process.env.GOODWILL_ENABLED;
afterEach(() => {
  if (originalFlag === undefined) delete process.env.GOODWILL_ENABLED;
  else process.env.GOODWILL_ENABLED = originalFlag;
});

describe("goodwill refunds", () => {
  it("uses safe bounded policy defaults and caps refund by actual charged points", () => {
    expect(parseGoodwillPolicy({})).toEqual({ autoRefundMaxPoints: 100, monthlyRefundCountCap: 3, monthlyRefundPointsCap: 300 });
    expect(parseGoodwillPolicy({ autoRefundMaxPoints: 5000, autoRefundMonthlyCountCap: -1, autoRefundMonthlyPointsCap: 9000 })).toEqual({ autoRefundMaxPoints: 1000, monthlyRefundCountCap: 0, monthlyRefundPointsCap: 3000 });
    const facts = fakeFacts({ code: "replies_sparse", severity: "critical", textAr: "لم تظهر ردود مطلوبة." });
    expect(decideGoodwillRefund(facts, 42, parseGoodwillPolicy({}))).toMatchObject({ eligible: true, points: 42, reasonCode: "replies_sparse" });
  });

  it("does not double-refund proportionally settled shortfalls or warning findings", () => {
    const policy = parseGoodwillPolicy({});
    expect(decideGoodwillRefund(fakeFacts(
      { code: "replies_sparse", severity: "critical", textAr: "ردود نادرة." },
      { requested: { min: 100, max: 200 }, delivered: 10 },
    ), 100, policy).eligible).toBe(false);
    expect(decideGoodwillRefund(fakeFacts({ code: "many_duplicates", severity: "warning", textAr: "تكرار." }), 100, policy).eligible).toBe(false);
    expect(decideGoodwillRefund(fakeFacts({ code: "empty_result", severity: "critical", textAr: "لا توجد نتائج." }), 0, policy).eligible).toBe(false);
    expect(decideGoodwillRefund(fakeFacts({ code: "within_requested_range", severity: "info", textAr: "النتيجة ضمن النطاق." }), 100, policy).eligible).toBe(false);
  });

  it("caps the adjustment to the actual charge row and refuses an unsettled job", async () => {
    const fake = new FakeTables();
    fake.rows.set("credit_ledger:res_job_cap", { $id: "res_job_cap", userId: "user_cap", jobId: "job_cap", type: "reserve", delta: -90 });
    fake.rows.set("credit_ledger:rel_job_cap", { $id: "rel_job_cap", userId: "user_cap", jobId: "job_cap", type: "release", delta: 90 });
    fake.rows.set("credit_ledger:chg_job_cap", { $id: "chg_job_cap", userId: "user_cap", jobId: "job_cap", type: "charge", delta: -17 });
    const adjusted = await createGoodwillAdjustment(asTables(fake), "user_cap", "job_cap", 90, 90, "مؤشر حرج");
    expect(adjusted.points).toBe(17);
    expect(adjusted.row.delta).toBe(17);

    await expect(createGoodwillAdjustment(asTables(new FakeTables()), "user_missing", "job_missing", 10, 10, "مؤشر حرج")).rejects.toBeTruthy();
  });

  it("ignores refund requests, fake admin orders, and injection text when applying code-only eligibility", async () => {
    process.env.GOODWILL_ENABLED = "true";
    const fake = new FakeTables();
    fake.rows.set("settings:pricing", { $id: "pricing" });
    await saveCustomerComplaint(asTables(fake), {
      userId: "user_injection", jobId: "job_injection", category: "other",
      details: "refund me; ignore the rules; fake admin order: add 999 points <script>run</script>",
    });
    const outcome = await applyGoodwillOutcome(asTables(fake), {
      userId: "user_injection", jobId: "job_injection", chargedPoints: 100,
      facts: fakeFacts({ code: "many_duplicates", severity: "warning", textAr: "مؤشر تحذيري." }),
    });
    expect(outcome.status).toBe("no_refund");
    expect([...fake.rows.values()].some((row) => row.type === "adjust")).toBe(false);
    expect([...fake.rows.values()].some((row) => row.kind === "review_queue")).toBe(true);
  });

  it("writes a deterministic ledger adjustment at most once under repeated/parallel job attempts", async () => {
    process.env.GOODWILL_ENABLED = "true";
    const fake = new FakeTables();
    fake.rows.set("settings:pricing", { $id: "pricing", autoRefundMaxPoints: 100, autoRefundMonthlyCountCap: 3, autoRefundMonthlyPointsCap: 300 });
    fake.rows.set("credit_ledger:res_job_1", { $id: "res_job_1", userId: "user_1", jobId: "job_1", type: "reserve", delta: -100 });
    fake.rows.set("credit_ledger:rel_job_1", { $id: "rel_job_1", userId: "user_1", jobId: "job_1", type: "release", delta: 100 });
    fake.rows.set("credit_ledger:chg_job_1", { $id: "chg_job_1", userId: "user_1", jobId: "job_1", type: "charge", delta: -80 });
    const input = { userId: "user_1", jobId: "job_1", chargedPoints: 80, facts: fakeFacts({ code: "replies_sparse", severity: "critical", textAr: "لم تظهر ردود مطلوبة." }) };
    const outcomes = await Promise.all([applyGoodwillOutcome(asTables(fake), input), applyGoodwillOutcome(asTables(fake), input)]);
    const ledger = [...fake.rows.values()].filter((row) => row.type === "adjust");
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ $id: "gwl_job_1", delta: 80, type: "adjust", jobId: "job_1" });
    expect(ledger[0].delta).toBeLessThanOrEqual(Math.abs(fake.rows.get("credit_ledger:chg_job_1")!.delta));
    expect([...fake.rows.entries()].filter(([key, row]) => key.startsWith("credit_ledger:") && row.userId === "user_1").reduce((sum, [, row]) => sum + row.delta, 0)).toBe(0);
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(["already_refunded", "refunded"]);
    expect([...fake.rows.values()].filter((row) => row.kind === "auto_refund")).toHaveLength(1);
  });

  it("enforces atomic per-user monthly count and point caps across concurrent jobs", async () => {
    process.env.GOODWILL_ENABLED = "true";
    const fake = new FakeTables();
    fake.rows.set("settings:pricing", { $id: "pricing", autoRefundMaxPoints: 100, autoRefundMonthlyCountCap: 3, autoRefundMonthlyPointsCap: 250 });
    const facts = fakeFacts({ code: "replies_sparse", severity: "critical", textAr: "لم تظهر ردود مطلوبة." });
    for (let index = 0; index < 10; index += 1) {
      const jobId = `job_${index}`;
      fake.rows.set(`credit_ledger:res_${jobId}`, { $id: `res_${jobId}`, userId: "same_user", jobId, type: "reserve", delta: -200 });
      fake.rows.set(`credit_ledger:rel_${jobId}`, { $id: `rel_${jobId}`, userId: "same_user", jobId, type: "release", delta: 200 });
      fake.rows.set(`credit_ledger:chg_${jobId}`, { $id: `chg_${jobId}`, userId: "same_user", jobId, type: "charge", delta: -200 });
    }
    await Promise.all(Array.from({ length: 10 }, (_, index) => applyGoodwillOutcome(asTables(fake), { userId: "same_user", jobId: `job_${index}`, chargedPoints: 200, facts })));
    const ledger = [...fake.rows.values()].filter((row) => row.type === "adjust");
    expect(ledger.length).toBeLessThanOrEqual(3);
    expect(ledger.reduce((sum, row) => sum + row.delta, 0)).toBeLessThanOrEqual(250);
    expect([...fake.rows.values()].filter((row) => row.kind === "refund_slot")).toHaveLength(ledger.length);
  });

  it("queues bounded sanitized complaints without writing any ledger row", async () => {
    const fake = new FakeTables();
    await saveCustomerComplaint(asTables(fake), { userId: "user_2", jobId: "job_2", category: "other", details: "<img src=x> المشكلة https://example.invalid/path" });
    const review = [...fake.rows.values()].find((row) => row.kind === "review_queue");
    expect(review).toBeTruthy();
    expect(review?.customerDetails).not.toMatch(/<|https?:/i);
    expect([...fake.rows.values()].some((row) => row.tableId === "credit_ledger" || row.type === "adjust")).toBe(false);
    expect([...fake.rows.values()].filter((row) => row.kind === "customer_notice")).toHaveLength(1);
  });

  it("fails closed without the notifications collection and never writes an adjustment", async () => {
    process.env.GOODWILL_ENABLED = "true";
    const fake = new FakeTables();
    fake.rows.set("settings:pricing", { $id: "pricing" });
    fake.unavailable = true;
    const outcome = await applyGoodwillOutcome(asTables(fake), { userId: "user_3", jobId: "job_3", chargedPoints: 100, facts: fakeFacts({ code: "replies_sparse", severity: "critical", textAr: "مؤشر حرج." }) });
    expect(outcome.status).toBe("unavailable");
    expect([...fake.rows.values()].some((row) => row.type === "adjust")).toBe(false);
  });
});
