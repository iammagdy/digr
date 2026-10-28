import { vi, expect } from "vitest";
import ExcelJS from "exceljs";
import { createMemoryDb, type MemoryDb } from "./memoryDb";
import { fakeMoneyClient } from "./agentMoney";
import { fakeRecorder, NOT_ADMIN, USER_ID } from "./agentHarness";
import { loadTregCatalog } from "../../src/lib/treg/catalog";
import { createFakeDriver, type FakeStep } from "../../agent/src/fakeDriver";
import { createMemoryStore, newMission, type MemoryStore } from "../../agent/src/memoryStore";
import { runExecution, runPlanning, type RunnerDeps } from "../../agent/src/runMission";
import type { MissionRecord } from "../../agent/src/types";
import type { TregCallOptions, TregCallResult } from "../../src/functions/shared/tregClient";
import type { AccountAccess } from "../../src/lib/treg/dataPolicy";
import type { PricedPlan } from "../../src/lib/agentMission/plan";
import { agentChatTurn } from "../../src/lib/agentMission/chatTurn";
import { approveForCustomer, loadCustomerMission } from "../../src/lib/agentMission/customerActions";
import { checkCustomerText } from "../../src/lib/agentMission/text";
import { repriceStoredPlan } from "../../src/lib/agentMission/lifecycle";
import type { CustomerMissionView } from "../../src/lib/agentMission/customerView";
import type { MissionNoticeFacts, MissionNoticeKind } from "../../src/lib/agentMission/notices";

/**
 * THE REPLAY HARNESS: a whole customer mission with ZERO real provider calls, end to end through the same code the site and the worker run:
 *
 *   the chat turn creates the mission  ->  the worker claims it and PLANS it with a fake model transcript against fake provider answers  ->  the customer's card is read through the customer
 *   API function  ->  the customer approves (the existing money functions, faked with the real arithmetic)  ->  the worker EXECUTES it (fake transcript, fake answers)  ->  settlement  ->  the
 *   files and the notice  ->  the customer's final view.
 *
 * `fetch` is stubbed to throw: a real network call from anywhere is a failure. The provider's answers are handed out in the order the calls are made (planning first, then execution).
 */
export interface ReplayInput {
  /** The customer's words in the chat. */
  request: string;
  /** Fake model transcript of the planning phase. */
  planning: FakeStep[];
  /** Fake model transcript of the execution phase, built from the approved plan. */
  execution: (plan: PricedPlan) => FakeStep[];
  /** Fake provider answers, in call order: planning calls first, then execution calls. */
  answers: Array<TregCallResult | ((o: TregCallOptions) => TregCallResult)>;
  access?: AccountAccess;
  balance?: number;
  models?: { planning: string; execution: string };
  /** The fake Context.dev / Firecrawl (tests/helpers/fakeContextDev.ts): when given, the agent has the web tools and its provider keys resolve to a test value. */
  web?: { fetchFn: ReturnType<typeof vi.fn>; requests: Array<{ url: string; body: any }> };
  /** Extra setup of the worker's dependencies. */
  deps?: (base: RunnerDeps) => RunnerDeps;
  /** The mission's store (default: the in-memory one). The stale-read store of cdnStaleStore.ts gives the real storage's read semantics. */
  makeStore?: () => MemoryStore;
}

export interface ReplayResult {
  db: MemoryDb;
  store: MemoryStore;
  money: ReturnType<typeof fakeMoneyClient>;
  rec: ReturnType<typeof fakeRecorder>;
  call: ReturnType<typeof vi.fn>;
  web: ReplayInput["web"];
  missionId: string;
  mission: MissionRecord;
  plannedPlan: PricedPlan;
  /** What the customer's card showed when the plan was ready. */
  planView: CustomerMissionView;
  /** The final view after execution. */
  finalView: CustomerMissionView;
  notices: Array<{ kind: MissionNoticeKind; facts: MissionNoticeFacts; jobId: string | null }>;
  planningDriver: ReturnType<typeof createFakeDriver>;
  executionDriver: ReturnType<typeof createFakeDriver>;
  initialBalance: number;
  /** Every customer-API answer the replay read (strings only checked by assertCustomerSafe). */
  customerAnswers: unknown[];
}

export const REPLAY_USER = USER_ID;
const MODELS = { planning: "claude-haiku-5-5", execution: "claude-haiku-5-5" };

/** A client over the memory database and the money fake, with a record of every table written. */
export function replayClient(db: MemoryDb, money: ReturnType<typeof fakeMoneyClient>) {
  const written: string[] = [];
  const client: any = {
    from: (t: string) => { const b = db.from(t); for (const m of ["insert", "update", "upsert"]) { const o = b[m]; b[m] = (...a: any[]) => { written.push(t); return o(...a); }; } return b; },
    rpc: money.client.rpc,
    storage: { from: (bucket: string) => ({ createSignedUrl: async (p: string) => ({ data: { signedUrl: `https://signed.example/${bucket}/${p}` }, error: null }) }) },
  };
  return { client, written };
}

export async function replay(input: ReplayInput): Promise<ReplayResult> {
  vi.stubGlobal("fetch", () => { throw new Error("a real network call was attempted"); });
  const db = createMemoryDb();
  const money = fakeMoneyClient({ balance: input.balance });
  const initialBalance = money.balance();
  const store = input.makeStore ? input.makeStore() : createMemoryStore();
  const { client } = replayClient(db, money);
  const rec = fakeRecorder({ dailyCapUsd: 5 });
  const queue = [...input.answers];
  const call = vi.fn(async (o: TregCallOptions) => { const n = queue.shift(); if (!n) throw new Error(`no fake provider answer left for ${o.endpointId}`); return typeof n === "function" ? n(o) : n; });
  const notices: ReplayResult["notices"] = [];
  const customerAnswers: unknown[] = [];

  // the worker's events and calls are mirrored into the tables the customer API reads
  let eventSeq = 0;
  const addEvent = store.addEvent.bind(store);
  store.addEvent = async (missionId, event) => {
    await addEvent(missionId, event);
    const stored = store.events[store.events.length - 1];
    db.rows("mission_events").push({ id: (eventSeq += 1), mission_id: missionId, kind: stored.kind, message_ar: stored.message_ar, counts: stored.counts ?? {}, created_at: new Date(Date.now() + eventSeq).toISOString() });
  };
  const addCall = store.addCall.bind(store);
  store.addCall = async (row) => { await addCall(row); db.rows("mission_calls").push({ ...row }); };
  db.seed("agent_worker_heartbeat", [{ worker_id: "w_replay", beat_at: new Date().toISOString() }]);

  // 1. the chat turn
  db.seed("conversations", [{ id: "conv1", user_id: REPLAY_USER, title: "محادثة جديدة" }]);
  db.seed("messages", [{ id: "u1", conversation_id: "conv1", role: "user", user_id: REPLAY_USER }, { id: "a1", conversation_id: "conv1", role: "assistant", user_id: REPLAY_USER }]);
  const turn = await agentChatTurn({ sb: client, userId: REPLAY_USER, conversationId: "conv1", userMsgId: "u1", assistantMsgId: "a1", message: input.request, conversationTitle: "محادثة جديدة" });
  if (!turn.ok) throw new Error(`the chat turn did not create a mission: ${turn.contentAr}`);
  const missionId = turn.missionId;
  const row = db.rows("missions").find((m) => m.id === missionId)!;
  Object.assign(row, { created_at: new Date().toISOString() }, Object.fromEntries(Object.entries(newMission({ id: missionId, user_id: REPLAY_USER })).filter(([k]) => row[k] === undefined)));
  store.missions.set(missionId, row as MissionRecord);

  const base = (driver: ReturnType<typeof createFakeDriver>): RunnerDeps => ({
    store, client, catalog: loadTregCatalog(), driver, recorder: rec.recorder, commit: rec.commit, call: call as any, models: input.models ?? MODELS,
    resolveAccess: async () => input.access ?? NOT_ADMIN,
    notify: async (n) => { notices.push({ kind: n.kind, facts: n.facts, jobId: n.jobId }); },
    ...(input.web ? { providerKey: async () => "test-provider-key", fetchFn: input.web.fetchFn as any } : {}),
  });
  const wire = (driver: ReturnType<typeof createFakeDriver>) => (input.deps ? input.deps(base(driver)) : base(driver));

  // 2. the worker plans it
  const claimedForPlanning = await store.claimMission("w_replay", 120);
  expect(claimedForPlanning?.id).toBe(missionId);
  expect(claimedForPlanning?.status).toBe("planning");
  const planningDriver = createFakeDriver(input.planning);
  await runPlanning(wire(planningDriver), store.missions.get(missionId)!);
  const planned = store.missions.get(missionId)!;
  if (planned.status !== "plan_ready" || !planned.plan) throw new Error(`planning did not end with a plan (status ${planned.status}; ${JSON.stringify(planningDriver.results.slice(-2))})`);

  // 3. the customer reads the card
  const planLoad = await loadCustomerMission(client, { id: missionId, userId: REPLAY_USER });
  if (!planLoad.ok) throw new Error("the customer could not read the mission");
  customerAnswers.push(planLoad);

  // 4. the customer approves
  const approved = await approveForCustomer(client, { id: missionId, userId: REPLAY_USER, isGuest: false, emailVerified: true });
  if (!approved.ok) throw new Error(`approval failed: ${approved.error}`);

  // 5. the worker executes it
  const claimedForExecution = await store.claimMission("w_replay", 120);
  expect(claimedForExecution?.status).toBe("executing");
  const executionDriver = createFakeDriver(input.execution(planned.plan), { costUsd: 0.004 });
  await runExecution(wire(executionDriver), store.missions.get(missionId)!);
  const mission = store.missions.get(missionId)!;

  const finalLoad = await loadCustomerMission(client, { id: missionId, userId: REPLAY_USER });
  if (!finalLoad.ok) throw new Error("the customer could not read the final mission");
  customerAnswers.push(finalLoad);

  return { db, store, money, rec, call, web: input.web, missionId, mission, plannedPlan: planned.plan, planView: planLoad.view, finalView: finalLoad.view, notices, planningDriver, executionDriver, initialBalance, customerAnswers };
}

const INTERNAL = /(treg|firecrawl|context\.dev|contextdev|anyapi|crawl4ai|litescrape|aiark|aviato|blitz|limadata|justoneapi|scrapecreators|tomba|\bx\.x\.|endpoint|call_\d{4}|out_\d{4}|msn_[a-z0-9]{6}|job_quote|quote_|USD|\$|measured_|worker_id)/i;

function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) strings(v, out);
  else if (value && typeof value === "object") for (const v of Object.values(value)) strings(v, out);
  return out;
}

/** What EVERY replay must show: the same invariants the owner asked for, checked on the real end state. */
export function assertReplayInvariants(r: ReplayResult, options: { expectDelivered?: number; expectStatus?: string } = {}): void {
  const m = r.mission;
  // nothing real: the provider was only ever called through the fake
  expect(r.call.mock.calls.length + (r.web?.fetchFn.mock.calls.length ?? 0)).toBeGreaterThan(0);
  // every event the worker wrote is Arabic only with no ASCII digit; the numbers are in the counts
  for (const e of r.store.events) {
    expect(checkCustomerText(e.message_ar, { maxChars: 1100 }).issues, e.message_ar).toEqual([]);
    expect(e.message_ar).not.toMatch(/[0-9]/);
    for (const [k, v] of Object.entries(e.counts ?? {})) { expect(k).toMatch(/^[a-z][a-z0-9_]*$/); expect(typeof v).toBe("number"); }
  }
  // the customer's two answers carry no endpoint, provider, id or dollar amount in any label or line (sample cells are data and are excluded)
  for (const a of r.customerAnswers as Array<{ view: CustomerMissionView }>) {
    const v = a.view;
    const labels = [v.summaryAr, v.priceLineAr, v.queueLineAr, v.currentLineAr, v.delayAr, v.remainingAr, v.closePageAr, v.resultSummaryAr, ...v.resultLinesAr, ...v.steps.flatMap((s) => [s.titleAr, s.detailAr, s.countAr]), ...v.stages.flatMap((s) => [s.titleAr, s.rowsAr, s.noteAr]), ...(v.samples ? [v.samples.stageTitleAr, ...v.samples.columns.map((c) => c.titleAr)] : []), ...v.files.map((f) => f.labelAr)].filter((x): x is string => typeof x === "string" && x.length > 0);
    for (const text of labels) { expect(text, text).not.toMatch(INTERNAL); expect(checkCustomerText(text, { maxChars: 1100 }).issues, text).toEqual([]); expect(text).not.toMatch(/[0-9]/); }
    // the card's stages add up to its total
    expect(v.stages.filter((s) => s.deliver).reduce((n, s) => n + s.rows, 0)).toBe(v.totalRows);
    expect(v.samples === null || (v.samples.rows.length >= 1 && v.samples.rows.length <= 3)).toBe(true);
    expect(JSON.stringify(strings(v.samples?.columns ?? []))).not.toMatch(/معرّ?ف/);
  }
  // the money: price by code from the measured cost, reserve x1.15, charge = ceil(delivered x unit) never above the reserve, the rest released; only the existing functions
  const plan = m.plan!;
  const price = repriceStoredPlan(plan);
  expect(price.unitPricePoints).toBe(plan.price.unitPricePoints);
  expect(price.reservePoints).toBe(plan.price.reservePoints);
  // the one pricing rule: the rule's unit is (provider + model cost) per delivered row x 5,500; the job stores the larger of it and the minimum spread over the volume; the reserve is max(minimum, ceil(volume x rule unit x 1.15))
  const ruleUnit = price.ruleUnitPoints ?? price.unitPricePoints;
  expect(Math.abs(ruleUnit - price.costPerFinalRowUsd * 5500)).toBeLessThan(0.0000011);
  expect(price.unitPricePoints).toBeGreaterThanOrEqual(ruleUnit);
  expect(price.reservePoints).toBe(Math.max(price.minChargePoints ?? 0, Math.ceil(Math.round(price.deliveredRows * ruleUnit * 1e6 * 1.15) / 1e6 - 1e-9)));
  expect(price.reservePoints).toBeLessThanOrEqual(25_000);
  expect(new Set(r.money.calls.map((c) => c.name))).toEqual(new Set(["create_quote_atomic", "accept_quote_atomic", "claim_job_chunk", "complete_chunk", "settle_job_atomic", ...(m.status === "unserved" ? ["release_job_atomic"] : [])]));
  const delivered = Number(m.delivered_units);
  if (options.expectDelivered !== undefined) expect(delivered).toBe(options.expectDelivered);
  expect(delivered).toBeLessThanOrEqual(price.deliveredRows);
  const expectedCharge = Math.min(Math.ceil(Math.round(delivered * price.unitPricePoints * 1e6) / 1e6 - 1e-9), price.reservePoints);
  expect(m.charged_points).toBe(expectedCharge);
  expect(r.money.balance()).toBe(r.initialBalance - expectedCharge);
  expect(r.money.ledger.filter((l) => l.type === "reserve")).toHaveLength(1);
  expect(r.money.ledger.filter((l) => l.type === "release")).toHaveLength(1);
  // every execution call was recorded against the job; every call was committed with its actual charge
  expect(r.rec.rows.filter((x) => x.jobId !== null).every((x) => x.jobId === m.job_id)).toBe(true);
  expect(r.rec.rows.every((x) => x.committedUsd !== null)).toBe(true);
  // the notice the customer gets when it ends
  expect(r.notices).toHaveLength(1);
  expect(r.notices[0].kind).toBe(options.expectStatus === "partial" ? "partial" : "completed");
  expect(r.notices[0].facts).toMatchObject({ delivered, hasJob: true });
  expect(m.status).toBe("completed");
}

/** Reads the delivered workbook back. */
export async function readWorkbook(r: ReplayResult): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(((await r.store.getFileBytes(r.missionId, "result/result.xlsx")) as unknown) as ArrayBuffer);
  return wb;
}

/** Paged fake answers for an endpoint that returns `perPage` rows a call and a cursor: `make(offset, n)` builds the page body. */
export function pagedAnswers(total: number, perPage: number, costUsd: number, make: (offset: number, n: number, nextCursor: string | null) => unknown, tregResult: (data: unknown, cost: number) => TregCallResult): TregCallResult[] {
  const out: TregCallResult[] = [];
  for (let offset = 0; offset < total; offset += perPage) {
    const n = Math.min(perPage, total - offset);
    out.push(tregResult(make(offset, n, offset + n < total ? `cur_${offset + n}` : null), costUsd));
  }
  return out;
}
