import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_ERROR_REQUEUES_MAX, AGENT_PHASE_STARTS_MAX } from "../src/lib/agentMission/constants";
import { approveMission } from "../src/lib/agentMission/lifecycle";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { createFakeDriver, type FakeStep } from "../agent/src/fakeDriver";
import { createMemoryStore, newMission, type MemoryStore } from "../agent/src/memoryStore";
import { ensureOwned, isOwnershipError, LeaseLostError, OwnershipUnverifiedError } from "../agent/src/ownership";
import { updateRunState } from "../agent/src/runState";
import { recoverFromError, runMissionSafely, runPlanning, type RunnerDeps } from "../agent/src/runMission";
import { runAddonSafely } from "../agent/src/stage4/runAddon";
import type { Results } from "./helpers/agentFakeWorld";
import { aboutWords, firstOutputId } from "./helpers/agentRelevance";
import { COMMENTS_ENDPOINT, NOT_ADMIN, POSTS_ENDPOINT, USER_ID, commentsPage, fakeRecorder, postsPage, tregResult } from "./helpers/agentHarness";
import { fakeMoneyClient } from "./helpers/agentMoney";
import { checkAddonLedger, reviewPricing } from "./helpers/addonWorld";
import { addonRunWorld } from "./helpers/addonRunWorld";
import { reviewCellsOf } from "../src/lib/agentMission/stage4/review";

/**
 * ROUND 56: THE MONEY GUARD FAILS CLOSED. Before this round `ensureOwned` (agent/src/ownership.ts) let the settlement go on when the mission row could not be
 * read (`catch { return; }`), when the row was missing, and when it named no worker. A worker that could not establish that it still owned the mission could
 * therefore settle, release or charge it. Each test below injects one fault at the exact moment between the published file and the settlement call and checks
 * that NO money function runs and NOTHING is written; then the fault clears, the lease runs out, the claim gives the mission to another worker, and the money
 * moves exactly once. Every scenario that fails closed here passed money through on the round 55 code (mutation-checked: see the PR).
 */
const fetchSpy = vi.fn(() => { throw new Error("a real network call was attempted"); });
beforeEach(() => { vi.stubGlobal("fetch", fetchSpy); });
afterEach(() => { vi.unstubAllGlobals(); });

const MODELS = { planning: "claude-haiku-5-5", execution: "claude-haiku-5-5" };
const MONEY = ["complete_chunk", "settle_job_atomic", "release_job_atomic"];
const ID = "msn_own";

type Fault = "db_error" | "timeout" | "row_missing" | "no_owner" | "not_running" | "other_worker";

/** An approved mission holding a reserve, 3 posts saved (20 approved: a partial delivery), claimed by w1, about to settle (its phase started the maximum number of times, so the run settles what is saved at once). */
async function world() {
  const store = createMemoryStore();
  const money = fakeMoneyClient();
  const rec = fakeRecorder();
  const notices: string[] = [];
  const logs: string[] = [];
  const deps = (over: Partial<RunnerDeps> = {}): RunnerDeps => ({
    store, client: money.client, catalog: loadTregCatalog(), driver: createFakeDriver([]), recorder: rec.recorder, commit: rec.commit,
    call: (async () => { throw new Error("no provider call in this test"); }) as any, models: MODELS, resolveAccess: async () => NOT_ADMIN,
    notify: async (n) => { notices.push(n.kind); }, log: (l) => logs.push(l), ownerId: "w1", leaseLost: () => false, ...over,
  });
  store.missions.set(ID, newMission({ id: ID, user_id: USER_ID, request_text: "أريد منشورات عن القهوة مع تعليقاتها", status: "planning" }));
  const queue = [tregResult(postsPage(5), 0.025), tregResult(commentsPage("9000", 12), 0.00144)];
  const idOf = (r: Results, n: number) => String(r.filter((x) => x.tool === "treg_call")[n]?.result.call_id);
  const script: FakeStep[] = [
    { tool: "catalog_search", args: { words: ["posts", "search"], platform: "x", limit: 5 } },
    { tool: "describe_endpoint", args: { id: POSTS_ENDPOINT } },
    { tool: "treg_call", args: { endpoint_id: POSTS_ENDPOINT, params: { query: "قهوة", max_results: 5 }, why: "the fixture source is the one under test" } },
    { tool: "treg_call", args: { endpoint_id: COMMENTS_ENDPOINT, params: { url: "https://x.example/p/9000" }, why: "the fixture source is the one under test" } },
    { tool: "run_code", args: { code: "return inputs.call_0001.data.slice(0, 1).map(r => ({ id: r.id, text: r.text, url: r.url }))", files: ["call_0001"] } },
    { tool: "propose_plan", args: (r) => ({ summary_ar: "ستحصل على المنشورات ثم تعليقات كل منشور في ورقتين مرتبطتين بمعرّف المنشور.", stages: [
      { key: "posts", title_ar: "المنشورات", endpoint_id: POSTS_ENDPOINT, expected_rows: 20, parent_key: null, deliver: true, columns: [{ key: "text", title_ar: "النص" }, { key: "url", title_ar: "الرابط" }], sample_rows: [{ id: "9000", text: "post 0", url: "https://x.example/p/9000" }], measured_by: [idOf(r, 0)], relevance: aboutWords(["post"]), yield_from: firstOutputId(r) },
      { key: "comments", title_ar: "التعليقات", endpoint_id: COMMENTS_ENDPOINT, expected_rows: 200, parent_key: "posts", per_parent_rows: 12, deliver: true, columns: [{ key: "text", title_ar: "النص" }], sample_rows: [{ id: "9000-c0", text: "comment 0" }], measured_by: [idOf(r, 1)] },
    ] }) },
  ];
  await runPlanning({ ...deps({ driver: createFakeDriver(script), ownerId: undefined }), call: (async () => queue.shift()!) as any }, store.missions.get(ID)!);
  const m = store.missions.get(ID)!;
  if (m.status !== "plan_ready") throw new Error(`planning ended ${m.status} ${m.error}`);
  const ok = await approveMission(money.client, { id: m.id, user_id: m.user_id, plan: m.plan! });
  if (!ok.ok) throw new Error(ok.messageAr);
  await store.updateMission(ID, { status: "executing", worker_id: "w1", lease_until: new Date(Date.now() + 60_000).toISOString(), job_id: ok.jobId, quote_id: ok.quoteId, reserved_points: ok.reservePoints, unit_price_points: ok.unitPricePoints });
  const rows = Array.from({ length: 3 }, (_, i) => ({ id: `p${i}`, text: "post t", url: `https://x.example/${i}` }));
  await store.putFile(ID, "rows/posts.json", JSON.stringify(rows), "application/json");
  await updateRunState(store, ID, (s) => ({ ...s, executionStarts: AGENT_PHASE_STARTS_MAX }));
  const balanceAfterHold = money.balance();
  const moneyCalls = () => money.calls.map((c) => c.name).filter((n) => MONEY.includes(n));
  const ledgerOf = (prefix: string) => money.ledger.filter((r) => r.id === `${prefix}${ok.jobId}`);
  return { store, money, deps, notices, logs, ok, balanceAfterHold, moneyCalls, ledgerOf, initialBalance: balanceAfterHold + ok.reservePoints };
}

/**
 * Injects `fault` at the moment the result file is published (the line before the settlement guard). Every mission write after that moment is recorded.
 * `heal()` ends the fault (the database is back).
 */
function inject(store: MemoryStore, fault: Fault) {
  let armed = false;
  let on = true;
  const writesAfter: string[] = [];
  const real = { getMission: store.getMission.bind(store), renewLeases: store.renewLeases.bind(store), updateMission: store.updateMission.bind(store), publishResult: store.publishResult.bind(store) };
  const down = () => armed && on && (fault === "db_error" || fault === "timeout");
  const fail = async (): Promise<never> => {
    if (fault === "timeout") await new Promise((r) => setTimeout(r, 5));
    throw new Error(fault === "timeout" ? "canceling statement due to statement timeout" : "connect ECONNREFUSED");
  };
  store.publishResult = async (a) => {
    const out = await real.publishResult(a);
    if (on && !armed) {
      armed = true;
      const m = store.missions.get(ID)!;
      if (fault === "row_missing") store.missions.delete(ID);
      if (fault === "no_owner") m.worker_id = null;
      if (fault === "not_running") m.status = "completed";
      if (fault === "other_worker") m.worker_id = "w2";
    }
    return out;
  };
  store.getMission = async (id) => (down() ? fail() : real.getMission(id));
  store.renewLeases = async (w, s, ids) => (down() ? fail() : real.renewLeases(w, s, ids));
  store.updateMission = async (id, patch) => { if (armed && on) writesAfter.push(String(patch.status ?? Object.keys(patch).join(","))); return real.updateMission(id, patch); };
  return { writesAfter, armed: () => armed, heal: () => { on = false; } };
}

describe("ensureOwned (unit): ownership is established only by positive evidence", () => {
  const row = (over: Record<string, unknown> = {}) => newMission({ id: "m", user_id: USER_ID, status: "executing", worker_id: "w1", lease_until: new Date(Date.now() - 1000).toISOString(), ...over });
  it("renewed for this worker: passes, and the lease is FRESH again (no other worker can claim it now)", async () => {
    const store = createMemoryStore([row()]);
    await ensureOwned({ store, ownerId: "w1" }, "m");
    expect(new Date(store.missions.get("m")!.lease_until!).getTime()).toBeGreaterThan(Date.now() + 60_000);
    expect(await store.claimMission("w2", 120)).toBeNull();
  });
  const refused: Array<[string, (s: MemoryStore) => void, string]> = [
    ["the renewal throws (database down)", (s) => { s.renewLeases = async () => { throw new Error("connect ECONNREFUSED"); }; }, "renew_failed"],
    ["the row cannot be read", (s) => { s.missions.get("m")!.worker_id = null; s.getMission = async () => { throw new Error("timeout"); }; }, "read_failed"],
    ["the row is missing", (s) => { s.missions.delete("m"); }, "row_missing"],
    ["the row names no worker", (s) => { s.missions.get("m")!.worker_id = null; }, "no_owner"],
    ["the row is ours but no longer running", (s) => { s.missions.get("m")!.status = "completed"; }, "not_running"],
    ["the renewal matched nothing although the row reads ours and running (a race)", (s) => { s.renewLeases = async () => []; }, "renew_failed"],
  ];
  for (const [label, arrange, reason] of refused) {
    it(`${label}: OwnershipUnverifiedError(${reason}), nothing revoked`, async () => {
      const store = createMemoryStore([row()]);
      arrange(store);
      let revoked = 0;
      const err = await ensureOwned({ store, ownerId: "w1", revokeOwnership: () => { revoked += 1; } }, "m").catch((e) => e);
      expect(err).toBeInstanceOf(OwnershipUnverifiedError);
      expect((err as OwnershipUnverifiedError).reason).toBe(reason);
      expect(isOwnershipError(err)).toBe(true);
      expect(revoked).toBe(0);
    });
  }
  it("another worker on the row: LeaseLostError and the run's ownership is revoked", async () => {
    const store = createMemoryStore([row({ worker_id: "w2" })]);
    let revoked = 0;
    await expect(ensureOwned({ store, ownerId: "w1", revokeOwnership: () => { revoked += 1; } }, "m")).rejects.toBeInstanceOf(LeaseLostError);
    expect(revoked).toBe(1);
  });
  it("a store that cannot say what it renewed is not proof either: a read of «ours and running» alone is refused (review of round 56)", async () => {
    const store = createMemoryStore([row()]);
    store.renewLeases = async () => undefined;
    const err = await ensureOwned({ store, ownerId: "w1" }, "m").catch((e) => e);
    expect(err).toBeInstanceOf(OwnershipUnverifiedError);
    expect((err as OwnershipUnverifiedError).reason).toBe("renew_failed");
  });
  it("the production worker always gives the run its worker id (a run without one is an in-process harness with no lease)", () => {
    const main = readFileSync(path.join(__dirname, "..", "agent", "src", "main.ts"), "utf8");
    expect(main).toMatch(/runClaimedSafely\(\{ \.\.\.deps\(\), store: view\.store, leaseLost: view\.revoked, ownerId: workerId, revokeOwnership \}/);
  });
});

describe("a fault between the published file and the settlement moves NO money and writes NOTHING", () => {
  for (const fault of ["db_error", "timeout", "row_missing", "no_owner", "not_running", "other_worker"] as const) {
    it(fault, async () => {
      const w = await world();
      const f = inject(w.store, fault);
      await runMissionSafely(w.deps(), w.store.missions.get(ID)!);
      expect(f.armed()).toBe(true); // the run did reach the settlement
      expect(w.moneyCalls()).toEqual([]); // no complete_chunk, no settle, no release
      expect(w.money.balance()).toBe(w.balanceAfterHold); // the hold is untouched: neither charged nor released
      expect(w.money.jobs.get(w.ok.jobId)!.status).not.toBe("completed");
      expect(f.writesAfter).toEqual([]); // no error recovery wrote over a row whose ownership is unknown
      expect(w.notices).toEqual([]); // the customer was told nothing false
      expect(w.logs.some((l) => l.startsWith("ownership_stop") || l.startsWith("lease_lost_stop"))).toBe(true);
    });
  }
});

describe("the existing lease path recovers it: settled exactly once, by what was delivered", () => {
  for (const fault of ["db_error", "timeout"] as const) {
    it(`${fault}: the lease runs out, w2 claims and settles; one charge, one release, charge = ceil(3 x unit) <= reserve`, async () => {
      const w = await world();
      const f = inject(w.store, fault);
      await runMissionSafely(w.deps(), w.store.missions.get(ID)!);
      expect(w.moneyCalls()).toEqual([]);
      f.heal();
      // w1 stopped renewing (its run ended); its lease runs out; the claim's expired-lease branch hands the mission to w2
      expect(await w.store.claimMission("w2", 120)).toBeNull(); // not before the lease ends
      w.store.missions.get(ID)!.lease_until = new Date(Date.now() - 1000).toISOString();
      const claimed = await w.store.claimMission("w2", 120);
      expect(claimed).toMatchObject({ id: ID, status: "executing", worker_id: "w2" });
      await runMissionSafely(w.deps({ ownerId: "w2" }), claimed!);
      const m = w.store.missions.get(ID)!;
      expect(m).toMatchObject({ delivered_units: 3, worker_id: null, lease_until: null });
      expect(m.status).toBe("completed");
      expect(m.charged_points).toBe(Math.ceil(3 * m.unit_price_points!));
      expect(m.charged_points!).toBeLessThanOrEqual(m.reserved_points!);
      expect(w.ledgerOf("chg_")).toHaveLength(1);
      expect(w.ledgerOf("rel_")).toHaveLength(1);
      expect(w.money.balance()).toBe(w.initialBalance - m.charged_points!);
      expect(w.money.balance()).toBeGreaterThanOrEqual(0);
    });
  }

  it("FAILED delivery (the files cannot be stored) during an outage: nothing is released by the uncertain run; the next owner releases the whole hold, charge 0", async () => {
    const w = await world();
    const f = inject(w.store, "db_error");
    const realPublish = w.store.publishResult;
    w.store.publishResult = async (a) => { await realPublish(a); throw new Error("storage: upload failed"); }; // arms the fault, then the files fail
    await runMissionSafely(w.deps(), w.store.missions.get(ID)!);
    expect(w.moneyCalls()).toEqual([]);
    expect(f.writesAfter).toEqual([]);
    f.heal();
    w.store.missions.get(ID)!.lease_until = new Date(Date.now() - 1000).toISOString();
    const claimed = await w.store.claimMission("w2", 120);
    await runMissionSafely(w.deps({ ownerId: "w2" }), claimed!);
    expect(w.store.missions.get(ID)).toMatchObject({ status: "failed", charged_points: 0, delivered_units: 0 });
    expect(w.ledgerOf("chg_")).toHaveLength(0);
    expect(w.money.balance()).toBe(w.initialBalance);
  });
});

describe("two workers, one mission", () => {
  it("w1 stalls past its lease, w2 takes over and settles; w1 resumes into its settlement: refused (the row names no worker now), no second financial action", async () => {
    const w = await world();
    // w1 stalls right after publishing its file
    let release!: () => void;
    const stalled = new Promise<void>((r) => { release = r; });
    let stalls = true;
    const realPublish = w.store.publishResult.bind(w.store);
    w.store.publishResult = async (a) => { const out = await realPublish(a); if (stalls) { stalls = false; await stalled; } return out; };
    let revoked = 0;
    const w1 = runMissionSafely(w.deps({ revokeOwnership: () => { revoked += 1; } }), w.store.missions.get(ID)!);
    await new Promise((r) => setTimeout(r, 20));
    w.store.missions.get(ID)!.lease_until = new Date(Date.now() - 1000).toISOString();
    const claimed = await w.store.claimMission("w2", 120);
    expect(claimed).toMatchObject({ worker_id: "w2" });
    await runMissionSafely(w.deps({ ownerId: "w2" }), claimed!);
    const charged = w.store.missions.get(ID)!.charged_points!;
    const callsAfterW2 = w.moneyCalls().length;
    release();
    await w1;
    // w2 already ended the mission (the row names no worker): w1's guard finds no positive ownership and stops (the other_worker case above revokes)
    expect(revoked).toBe(0);
    expect(w.logs.some((l) => l.startsWith(`ownership_stop ${ID}`) && l.includes("no_owner"))).toBe(true);
    expect(w.moneyCalls().length).toBe(callsAfterW2); // w1 called no money function
    expect(w.ledgerOf("chg_")).toHaveLength(1);
    expect(w.money.balance()).toBe(w.initialBalance - charged);
  });

  it("the read-check-write window: w1's lease had lapsed but nobody claimed it; the guard RENEWS it, so a competing claim during the settlement finds nothing", async () => {
    const w = await world();
    w.store.missions.get(ID)!.lease_until = new Date(Date.now() - 1000).toISOString(); // w1 was slow, the lease ran out
    const realRpc = w.money.client.rpc.bind(w.money.client);
    let competitor: unknown = "not tried";
    w.money.client.rpc = async (name: string, args: any) => {
      if (name === "complete_chunk" && competitor === "not tried") competitor = await w.store.claimMission("w2", 120); // another worker polls at the worst moment
      return realRpc(name, args);
    };
    await runMissionSafely(w.deps(), w.store.missions.get(ID)!);
    expect(competitor).toBeNull();
    expect(w.ledgerOf("chg_")).toHaveLength(1);
  });
});

describe("recoverFromError's last resort never releases on an ownership refusal", () => {
  it("a one-shot outage at the guard inside the recovery: no release of a published file's hold; the lease path settles it once", async () => {
    const w = await world();
    await updateRunState(w.store, ID, (s) => ({ ...s, executionStarts: 0, errorRequeues: AGENT_ERROR_REQUEUES_MAX }));
    const real = w.store.renewLeases.bind(w.store);
    let failures = 1;
    w.store.renewLeases = async (a, b, c) => { if (failures > 0) { failures -= 1; throw new Error("connect ECONNREFUSED"); } return real(a, b, c); };
    await recoverFromError(w.deps(), w.store.missions.get(ID)!, new Error("the run failed"));
    expect(w.moneyCalls()).toEqual([]); // the round 55 code fell through to «release the whole hold» once the second check passed
    expect(w.store.missions.get(ID)!.status).toBe("executing");
    w.store.missions.get(ID)!.lease_until = new Date(Date.now() - 1000).toISOString();
    const claimed = await w.store.claimMission("w2", 120);
    await runMissionSafely(w.deps({ ownerId: "w2" }), claimed!);
    expect(w.store.missions.get(ID)!.charged_points).toBe(Math.ceil(3 * w.store.missions.get(ID)!.unit_price_points!));
    expect(w.ledgerOf("chg_")).toHaveLength(1);
  });
});

describe("settlement retry after a crash between the charge and the final write", () => {
  it("the next owner settles again: no second charge, no second release, the balance is charged once", async () => {
    const w = await world();
    const real = w.store.updateMission.bind(w.store);
    let crashed = false;
    w.store.updateMission = async (id, patch) => { if (!crashed && patch.status === "completed") { crashed = true; throw new Error("process killed"); } return real(id, patch); };
    // the crash: the run ends with an exception and the process is gone, so no recovery runs; the lease runs out
    await runMissionSafely(w.deps({ leaseLost: () => crashed }), w.store.missions.get(ID)!);
    expect(crashed).toBe(true);
    expect(w.ledgerOf("chg_")).toHaveLength(1);
    const chargedOnce = w.initialBalance - w.money.balance();
    w.store.missions.get(ID)!.lease_until = new Date(Date.now() - 1000).toISOString();
    const claimed = await w.store.claimMission("w2", 120);
    await runMissionSafely(w.deps({ ownerId: "w2" }), claimed!);
    expect(w.ledgerOf("chg_")).toHaveLength(1);
    expect(w.ledgerOf("rel_")).toHaveLength(1);
    expect(w.initialBalance - w.money.balance()).toBe(chargedOnce);
    expect(w.store.missions.get(ID)!.worker_id).toBeNull(); // not stranded
  });
});

describe("add-on settlement", () => {
  it("a database outage at the add-on's settlement: no settle and no write; after the lease path, settled once (res -P, rel +P, chg -P)", async () => {
    const w = await addonRunWorld({ world: "m12", balance: 10_000 });
    const pricing = reviewPricing(reviewCellsOf(w.v1));
    const P = pricing.holdPoints;
    const a = await w.createApproved({ kind: "review", request: { kind: "review" }, pricing, requestText: "راجع الملف" });
    const realRenew = w.store.renewLeases.bind(w.store);
    let down = true;
    w.store.renewLeases = async (x, y, z) => { if (down) throw new Error("connect ECONNREFUSED"); return realRenew(x, y, z); };
    const writes: string[] = [];
    const realUpdate = w.store.updateMission.bind(w.store);
    w.store.updateMission = async (id, patch) => { if (down) writes.push(String(patch.status ?? "")); return realUpdate(id, patch); };
    await runAddonSafely({ ...w.deps, ownerId: "worker-1", leaseLost: () => false }, a.row);
    expect(w.money.ledger.map((r) => r.type)).toEqual(["topup", "reserve"]); // nothing released, nothing charged
    expect(w.money.balance()).toBe(10_000 - P);
    expect(writes.filter((s) => s === "failed" || s === "approved" || s === "completed")).toEqual([]);
    expect(w.rowOf(a.id).status).toBe("executing");
    down = false;
    w.expireLease(a.id);
    const again = await w.reclaim();
    await runAddonSafely({ ...w.deps, ownerId: "worker-2", leaseLost: () => false }, again);
    expect(checkAddonLedger(w.money, a.jobId, { reserved: P, charged: P })).toEqual([]);
    expect(w.money.balance()).toBe(10_000 - P);
    expect(w.reviewFiles()).toEqual([`${w.mission}/reviews/r0001.json`]);
  });
});

describe("cancellation cannot race a settlement", () => {
  it("a mission that holds money cannot be cancelled by the customer or the admin (only unheld statuses are withdrawable)", () => {
    const chat = readFileSync(path.join(__dirname, "..", "src", "lib", "agentMission", "chatTurn.ts"), "utf8");
    expect(chat).toMatch(/const WITHDRAWABLE = \["queued", "needs_input", "plan_ready"\];/);
    expect(chat).toMatch(/const REPLACEABLE = \["plan_ready", "needs_input"\];/);
    const admin = readFileSync(path.join(__dirname, "..", "src", "lib", "agentMission", "adminActions.ts"), "utf8");
    expect(admin).toContain('.eq("id", input.id).in("status", ["queued", "needs_input", "plan_ready"]);');
    expect(admin).toContain('if (!["queued", "needs_input", "plan_ready"].includes(data.status)) return bad(409');
  });
});

describe("review of round 56: a stale run can no longer strand an executing mission", () => {
  it("a stale PLANNING run that ends without a card does not clear the worker and lease of a mission another worker now executes", async () => {
    const w = await world();
    // the row is executing under w3 (re-planned, approved and claimed while w1's planning was stalled)
    w.store.missions.get(ID)!.worker_id = "w3";
    const before = { ...w.store.missions.get(ID)! };
    const stale = { ...before, status: "planning" as const, worker_id: "w1" };
    // w1's planning run resumes and ends with no card: the model gives up at once
    await runMissionSafely(w.deps({ driver: createFakeDriver([]), ownerId: "w1" }), stale);
    const after = w.store.missions.get(ID)!;
    expect(after.worker_id).toBe("w3");
    expect(after.lease_until).toBe(before.lease_until);
    expect(after.status).toBe("executing");
  });

  it("a release the database refuses after the files failed is never told as «nothing was charged»", async () => {
    const w = await world();
    await updateRunState(w.store, ID, (s) => ({ ...s, executionStarts: 0, errorRequeues: AGENT_ERROR_REQUEUES_MAX }));
    // the job was already settled and charged by an earlier attempt; the settlement and the release are now refused
    const realRpc = w.money.client.rpc.bind(w.money.client);
    w.money.client.rpc = async (name: string, args: any) => (MONEY.includes(name) ? { error: { message: "job already settled" } } : realRpc(name, args));
    const realPublish = w.store.publishResult.bind(w.store);
    w.store.publishResult = async (a) => { await realPublish(a); throw new Error("storage: upload failed"); };
    await recoverFromError(w.deps(), w.store.missions.get(ID)!, new Error("the run failed"));
    const m = w.store.missions.get(ID)!;
    expect(m.status).toBe("failed");
    expect(m.charged_points).not.toBe(0);
    expect(m.error).toMatch(/^settlement /);
    const last = w.store.events[w.store.events.length - 1].message_ar;
    expect(last).toBe("تعذّرت التسوية الآلية للمهمة؛ راجع المشرف ولم يُخصم رصيد إضافي.");
    expect(w.notices).not.toContain("failed");
  });
  it("the same in recoverFromError's LAST RESORT (the item log itself cannot be read): a refused release is never told as «nothing was charged»", async () => {
    const w = await world();
    await updateRunState(w.store, ID, (s) => ({ ...s, executionStarts: 0, errorRequeues: AGENT_ERROR_REQUEUES_MAX }));
    const realRpc = w.money.client.rpc.bind(w.money.client);
    w.money.client.rpc = async (name: string, args: any) => (MONEY.includes(name) ? { error: { message: "job already settled" } } : realRpc(name, args));
    w.store.listFiles = async () => { throw new Error("storage: list failed"); };
    const logs: string[] = [];
    await recoverFromError(w.deps({ log: (l) => logs.push(l) }), w.store.missions.get(ID)!, new Error("the run failed"));
    expect(logs.some((l) => l.startsWith(`settle_failed ${ID}`))).toBe(true); // the last resort was reached
    const m = w.store.missions.get(ID)!;
    expect(m).toMatchObject({ status: "failed", worker_id: null, lease_until: null });
    expect(m.charged_points).not.toBe(0);
    expect(w.store.events[w.store.events.length - 1].message_ar).toBe("تعذّرت التسوية الآلية للمهمة؛ راجع المشرف ولم يُخصم رصيد إضافي.");
    expect(w.notices).not.toContain("failed");
  });
});
