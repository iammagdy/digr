import { createHash } from "node:crypto";
import ExcelJS from "exceljs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryStore, newMission } from "../agent/src/memoryStore";
import { createSupabaseStore } from "../agent/src/supabaseStore";
import { advanceMissionDelivery, type DeliveryPreparation } from "../agent/src/missionSettlement";
import { runExecution, type RunnerDeps } from "../agent/src/runMission";
import { buildMissionFiles } from "../agent/src/workbook";
import type { PricedPlan, PricedStage } from "../src/lib/agentMission/plan";
import { fakeMoneyClient, quoteJobId } from "./helpers/agentMoney";

const USER = "fixture-user";
const MISSION = "msn_fixture";
const JOB = quoteJobId("fixture-quote");
const START = Date.parse("2026-11-21T08:00:00Z");
const FIXTURE_HASH = "a".repeat(64);
const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(START); });
afterEach(() => vi.useRealTimers());

const sampleStage = (key: string, title_ar: string, planned_rows: number, parent_key: string | null, columns: PricedStage["columns"]): PricedStage => ({
  key, title_ar, planned_rows, expected_rows: planned_rows, parent_key, columns, deliver: true,
  endpoint_id: "fixture.items", sample_rows: [], measured_by: [], measured_from_calls: [], measured_cost_per_row_usd: 0,
});
const names = [{ key: "name", title_ar: "الاسم" }];
const phone = [...names, { key: "phone", title_ar: "التليفون", kind: "phone" as const }];
const people = sampleStage("people", "الأشخاص", 3, "companies", [...phone, { key: "email", title_ar: "الإيميل", kind: "work_email" }]);
const contacts = (["email", "phone"] as const).map((kind) => ({ kind, column_key: kind, stage_key: "people", status_key: kind, per_person_usd: 0, finders: [] }));
const rows = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `row-${index}`, name: `عنصر ${index}` }));
const CONTACT_ROWS = {
  companies: rows(3),
  people: [
    { id: "person-one", parent_id: "row-0", name: "الأول", email: "person@example.test" },
    { id: "person-two", parent_id: "row-1", name: "الثاني", phone: "+20 2 5555 0123" },
    { id: "person-three", parent_id: "row-2", name: "الثالث", phone: "معرّف 12345678" },
  ],
};
const CONTACT_STAGES = [sampleStage("companies", "الشركات", 3, null, names), people];
const NOTES = { date: new Date(START).toISOString(), llm: 0, executionTregUsd: 0, costUsd: 0, summary: null, outputError: null };

async function world(plan: PricedPlan) {
  const money = fakeMoneyClient({ balance: 2_000 });
  const store = createMemoryStore();
  const { unitPricePoints, reservePoints, deliveredRows } = plan.price;
  const p_quote_id = "fixture-quote";
  const p_user_id = USER;
  await money.client.rpc("create_quote_atomic", {
    p_quote_id, p_user_id, p_quote_hash: FIXTURE_HASH, p_total_points: reservePoints,
    p_items: [{ endpointId: "agent-mission", missionId: MISSION, unitPricePoints, targetVolumeMin: 1, targetVolumeMax: deliveredRows }],
    p_output_formats: ["xlsx", "csv"], p_expires_at: new Date(START + 3600000).toISOString(),
  });
  expect((await money.client.rpc("accept_quote_atomic", { p_quote_id, p_user_id, p_expected_quote_hash: FIXTURE_HASH })).data?.success).toBe(true);
  await money.client.rpc("claim_job_chunk", { p_job_id: JOB, p_expected_step: 0, p_lease_seconds: 21600 });
  store.missions.set(MISSION, newMission({
    id: MISSION, user_id: USER, plan, status: "executing", worker_id: "first", job_id: JOB, quote_id: p_quote_id,
    lease_until: new Date(START + 120000).toISOString(), reserved_points: reservePoints, unit_price_points: unitPricePoints,
  }));
  money.bindDeliveryMissions({
    get: (id) => store.missions.get(id),
    park: (id, due) => Object.assign(store.missions.get(id)!, { status: "approved", worker_id: null, lease_until: due }),
  });
  const provider = vi.fn(async () => { throw new Error("provider work re-entered finalization"); });
  const model = vi.fn(async () => { throw new Error("model work re-entered finalization"); });
  const deps = (ownerId: string) => ({ store, client: money.client, ownerId, call: provider, driver: { run: model }, models: { execution: "fixture" } }) as unknown as RunnerDeps;
  const record = () => ({ ...store.missions.get(MISSION)! });
  const takeDue = async (worker: string, offset: number) => {
    expect(Date.parse(record().lease_until!)).toBe(START + offset * 1000);
    vi.setSystemTime(START + offset * 1000 + 1);
    const mission = await store.claimMission(worker, 120);
    if (!mission) throw new Error("due mission was not claimed");
    return mission;
  };
  return { money, store, record, takeDue, deps, provider, model };
}

function priced(stages: PricedStage[], unitPricePoints: number, reservePoints: number, contact_steps?: PricedPlan["contact_steps"]): PricedPlan {
  const deliveredRows = stages.reduce((total, stage) => total + stage.planned_rows, 0);
  return { summary_ar: "نتائج تجريبية", stages, contact_steps, price: {
    deliveredRows, unitPricePoints, reservePoints, maxChargePoints: reservePoints, totalCostUsd: 0, costPerFinalRowUsd: 0, overCap: false,
  } as PricedPlan["price"] };
}

const CONTACT_PLAN = priced(CONTACT_STAGES, 154.62, 1067, contacts);
const PARTIAL = priced([sampleStage("items", "النتائج", 12, null, names)], 40.05, 553);
const SOCIAL = priced([sampleStage("comments", "التعليقات", 30, null, names)], 6.666666, 200);

async function actualSheetRows(bytes: Buffer): Promise<number[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as never);
  return workbook.worksheets.slice(1).map((sheet) => sheet.rowCount - 1);
}

describe("ordinary mission settlement uses the downloadable artifact", () => {
  it.each([
    { label: "two valid contacts and one unbilled person", plan: CONTACT_PLAN, data: CONTACT_ROWS, physical: [3, 3], billed: 5, charge: 774 },
    { label: "six of twelve", plan: PARTIAL, data: { items: rows(6) }, physical: [6], billed: 6, charge: 241 },
    { label: "empty", plan: PARTIAL, data: null, physical: [], billed: 0, charge: 0 },
    { label: "social 30 of 30", plan: SOCIAL, data: { comments: rows(30) }, physical: [30], billed: 30, charge: 200 },
    { label: "file delivered without a billable person", plan: priced([{ ...people, parent_key: null }], 154.62, 553, contacts), data: { people: rows(3) }, physical: [3], billed: 0, charge: 0 },
  ])("$label", async ({ plan, data, physical, billed, charge }) => {
    const w = await world(plan);
    const total = physical.reduce((sum, n) => sum + n, 0);
    const output = data ? await buildMissionFiles(plan, data) : null;
    const result = await advanceMissionDelivery(w.deps("first"), w.record(), async () => ({ workbook: output, notes: NOTES }));
    expect(result).toMatchObject({ receipt: { physical_units: total, billable_units: billed, charged_credits: charge, refunded_credits: plan.price.reservePoints - charge } });
    if (typeof result === "string") throw new Error(result);
    const { receipt } = result;
    expect(w.money.jobs.get(JOB)?.delivered_units).toBe(billed);
    expect(w.money.balance()).toBe(2000 - charge);
    expect(w.money.ledger.filter((entry) => entry.job_id === JOB).map((entry) => entry.id))
      .toEqual([`res_${JOB}`, `rel_${JOB}`, ...(charge > 0 ? [`chg_${JOB}`] : [])]);
    if (output) {
      const stored = await w.store.getFileBytes(MISSION, "result/result.xlsx");
      expect(await actualSheetRows(stored!)).toEqual(physical);
      expect(stored).toEqual(output.xlsx);
      expect(receipt.xlsx_sha).toBe(digest(stored!));
      expect(w.store.files.get(`results/${receipt.xlsx_path}`)).toEqual(stored);
    } else expect(receipt.xlsx_path).toBeNull();
  });

  it.each(["missing", "unreadable", "transient"] as const)("a %s staged workbook restarts only finalization", async (fault) => {
    const w = await world(PARTIAL);
    const original = await buildMissionFiles(PARTIAL, { items: rows(6) });
    const replacement = await buildMissionFiles(PARTIAL, { items: rows(3) });
    const realRead = w.store.getFileBytes.bind(w.store);
    let fail = true;
    w.store.getFileBytes = async (id, path) => {
      if (fail && path.startsWith("settlement/candidate-")) {
        if (fault === "unreadable") throw new Error("storage unavailable");
        return null;
      }
      if (fail && path === "settlement/v1.json" && Date.now() > START) throw new Error("manifest unavailable");
      return realRead(id, path);
    };
    const initial = vi.fn<() => Promise<DeliveryPreparation>>(async () => ({ workbook: original, notes: NOTES }));
    expect(await advanceMissionDelivery(w.deps("first"), w.record(), initial)).toBe("parked");
    expect(w.record()).toMatchObject({ status: "approved", charged_points: null });
    const second = await w.takeDue("second", 15);
    if (fault === "transient") {
      fail = false;
      await runExecution(w.deps("second"), second);
      expect(w.record()).toMatchObject({ status: "completed", charged_points: 241, delivered_units: 6 });
      expect(await w.store.getFileBytes(MISSION, "result/result.xlsx")).toEqual(original.xlsx);
    } else {
      const replace = vi.fn(async () => ({ workbook: replacement, notes: NOTES }));
      expect(await advanceMissionDelivery(w.deps("second"), second, replace)).toBe("parked");
      for (const [worker, offset] of [["third", 60], ["fourth", 150], ["fifth", 166]] as const) {
        // The nominal first release offset is 165; the last failed trial also enforces 15 seconds after its actual start.
        const due = offset === 166 ? Date.parse(w.record().lease_until!) : START + offset * 1000;
        const next = await w.takeDue(worker, (due - START) / 1000);
        await runExecution(w.deps(worker), next);
      }
      expect(replace).not.toHaveBeenCalled();
      expect(w.record()).toMatchObject({ status: "failed", charged_points: 0, delivered_units: 0, files: null });
      expect(w.money.balance()).toBe(2000);
      expect(w.money.ledger.filter((entry) => entry.job_id === JOB).map((entry) => entry.type)).toEqual(["reserve", "release"]);
      expect(w.store.published).toHaveLength(0);
      vi.setSystemTime(START + 226000);
      expect(await w.store.claimMission("sixth", 120)).toBeNull();
    }
    expect(initial).toHaveBeenCalledTimes(1);
    expect(w.provider).not.toHaveBeenCalled();
    expect(w.model).not.toHaveBeenCalled();
  });

  it("a committed delivery survives a lost reply, unreadable manifest and a new owner", async () => {
    const w = await world(CONTACT_PLAN);
    const original = await buildMissionFiles(CONTACT_PLAN, CONTACT_ROWS);
    w.money.inject("finalize_agent_delivery_atomic", "after");
    const realRpc = w.money.client.rpc.bind(w.money.client);
    let lost = false;
    w.money.client.rpc = async (name, args) => {
      if (lost && name === "claim_agent_delivery_attempt_atomic") throw new Error("database connection lost");
      try { return await realRpc(name, args); } catch (error) { lost = true; throw error; }
    };
    expect(await advanceMissionDelivery(w.deps("first"), w.record(), async () => ({ workbook: original, notes: NOTES }))).toBe("parked");
    expect(w.money.balance()).toBe(1226);
    expect(w.record().charged_points).toBeNull();
    w.money.client.rpc = realRpc;
    const realRead = w.store.getFileBytes.bind(w.store);
    w.store.getFileBytes = async (id, path) => {
      if (path.startsWith("settlement/")) throw new Error("staging unreadable");
      return realRead(id, path);
    };
    vi.setSystemTime(START + 121000);
    const takeover = await w.store.claimMission("second", 120);
    await runExecution(w.deps("second"), takeover!);
    expect(w.record()).toMatchObject({ status: "completed", delivered_units: 6, charged_points: 774, files: [{ sha256: digest(original.xlsx) }, { kind: "csv" }] });
    expect(await w.store.getFileBytes(MISSION, "result/result.xlsx")).toEqual(original.xlsx);
    expect(w.money.ledger.filter((entry) => entry.job_id === JOB).map((entry) => entry.type)).toEqual(["reserve", "release", "charge"]);
    expect(w.provider).not.toHaveBeenCalled();
    expect(w.model).not.toHaveBeenCalled();
  });
});

describe("ordinary publication is create-only even when an upload finishes late", () => {
  it.each(["agent-missions", "results"])("retains both verified XLSX and CSV copies after a delayed %s upload", async (delayBucket) => {
    const objects = new Map<string, Buffer>();
    const artifacts = new Map<string, Record<string, unknown>>();
    let release!: () => void;
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const startedUpload = new Promise<void>((resolve) => { started = resolve; });
    let delayed = false;
    const store = createSupabaseStore({
      storage: { from: (bucket: string) => ({
        async upload(path: string, bytes: Buffer, options: { upsert: boolean }) {
          if (!delayed && bucket === delayBucket && path.endsWith("result.xlsx")) { delayed = true; started(); await waiting; }
          const key = `${bucket}/${path}`;
          if (objects.has(key) && !options.upsert) return { error: { code: "Duplicate" } };
          objects.set(key, bytes);
          return { data: {} };
        },
        async download(path: string) {
          const data = objects.get(`${bucket}/${path}`);
          return data ? { data: new Blob([new Uint8Array(data)]) } : { error: { message: "missing" } };
        },
      }) },
      from: () => ({
        insert: async (row: Record<string, unknown>) => {
          if (artifacts.has(String(row.id))) return { error: { code: "23505" } };
          artifacts.set(String(row.id), row); return { data: null };
        },
        select: () => ({ eq: (_key: string, id: string) => ({ maybeSingle: async () => ({ data: artifacts.get(id) }) }) }),
      }),
    });
    const w = await world(PARTIAL);
    w.store.publishResult = store.publishResult.bind(store);
    const workbook = await buildMissionFiles(PARTIAL, { items: rows(6) });
    const late = advanceMissionDelivery(w.deps("first"), w.record(), async () => ({ workbook, notes: NOTES }))
      .catch((error: unknown) => error);
    await startedUpload;
    vi.setSystemTime(START + 121000);
    const takeover = await w.store.claimMission("second", 120);
    expect(takeover?.worker_id).toBe("second");
    await runExecution(w.deps("second"), takeover!);
    const winner = w.money.receipts.get(JOB)!;
    expect(winner).toMatchObject({ physical_units: 6, charged_credits: 241, xlsx_sha: digest(workbook.xlsx) });
    release();
    expect(await late).toMatchObject({ name: "OwnershipUnverifiedError" });
    expect(w.money.ledger.filter((entry) => entry.job_id === JOB).map((entry) => entry.type)).toEqual(["reserve", "release", "charge"]);
    const storedCsv = w.money.receipts.get(JOB)?.csv_sha;
    const different = Buffer.from("different");
    const csv = Buffer.from(objects.get(`results/${winner.csv_path}`)!).toString("utf8");
    const input = { missionId: MISSION, userId: USER, jobId: JOB, xlsx: different, csv,
      sealed: { xlsxSha256: digest(different), csvSha256: digest(csv) } };
    await expect(store.publishResult(input)).rejects.toThrow();
    expect(objects.get(`agent-missions/${MISSION}/result/result.xlsx`)).toEqual(workbook.xlsx);
    expect(objects.size).toBe(4);
    expect([...objects].filter(([path]) => path.endsWith(".xlsx")).map(([, bytes]) => digest(bytes))).toEqual([digest(workbook.xlsx), digest(workbook.xlsx)]);
    expect([...objects].filter(([path]) => path.endsWith(".csv")).map(([, bytes]) => digest(bytes))).toEqual([storedCsv, storedCsv]);
    expect([...artifacts.values()]).toEqual([expect.objectContaining({ file_id_csv: winner.csv_path, file_id_xlsx: winner.xlsx_path })]);
  });
});
