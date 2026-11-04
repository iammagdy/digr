import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryDb, type MemoryDb } from "./helpers/memoryDb";
import { fakeMoneyClient } from "./helpers/agentMoney";
import { pricedTwoStagePlan } from "./helpers/agentPlan";
import { addonRowOf } from "./helpers/reviewQuoteWorld";
import { customerPlanView } from "../src/lib/agentMission/plan";
import { approveForCustomer } from "../src/lib/agentMission/customerActions";

/**
 * MONEY PR 7d, PHASE 2B-2 TASK 3: THE EXISTING MISSION APPROVAL REFUSES AN ADD-ON ROW (docs/MONEY-PR-7A.md section 16.4). A review request is a `missions` row whose plan is `{ addon }`, `plan_ready`, and the customer is handed its id. The existing approval
 * (`approveForCustomer` -> `approveMissionOnce`) knows only a priced mission plan: it would claim the row (`approved`) and then fail on the plan, leaving a request stuck. An add-on is approved by its own function (`approveAddonOnce`, a later task). So the existing path
 * refuses such a row BEFORE anything is read, held or written. An ordinary mission is approved exactly as before.
 */
const ME = "u-1";
let db: MemoryDb;
beforeEach(() => { db = createMemoryDb(); });

function makeClient(db: MemoryDb) {
  const money = fakeMoneyClient();
  const written: string[] = [];
  const client: any = {
    from: (t: string) => { const b = db.from(t); for (const m of ["insert", "update", "upsert"]) { const o = b[m]; b[m] = (...a: any[]) => { written.push(`${m} ${t}`); return o(...a); }; } return b; },
    rpc: money.client.rpc,
  };
  return { client, money, written };
}
const ordinary = () => ({ id: "msn_ready0001", user_id: ME, status: "plan_ready", request_text: "هات منشورات", plan: pricedTwoStagePlan(), plan_public: customerPlanView(pricedTwoStagePlan()), created_at: "2026-10-28T10:00:00Z" });
const approve = (client: any, id: string) => approveForCustomer(client, { id, userId: ME, isGuest: false, emailVerified: true });

describe("an add-on row is not approved as a mission", () => {
  it("a waiting review request: 409, no money function, no write, the row stays plan_ready, and the precheck is never asked", async () => {
    const row = addonRowOf({ status: "plan_ready", kind: "review", base: 1 });
    db.seed("missions", [row]);
    const { client, money, written } = makeClient(db);
    let prechecks = 0;
    const r = await approveForCustomer(client, { id: row.id, userId: ME, isGuest: false, emailVerified: true, precheck: async () => { prechecks += 1; return { ok: true }; } });
    expect(r).toMatchObject({ ok: false, status: 409 });
    expect(String((r as any).error)).toMatch(/[؀-ۿ]/);
    expect(prechecks).toBe(0);
    expect(money.calls).toHaveLength(0);
    expect(money.ledger.filter((l) => l.type !== "topup")).toHaveLength(0);
    expect(written).toEqual([]);
    expect(db.rows("missions")[0].status).toBe("plan_ready");
  });
  it("an edit or fix request too, and a row whose plan merely has an `addon` key", async () => {
    for (const kind of ["edit", "review_fix"] as const) {
      db.reset(); db.seed("missions", [addonRowOf({ status: "plan_ready", kind, base: 1 })]);
      const { client, money, written } = makeClient(db);
      expect(await approve(client, db.rows("missions")[0].id)).toMatchObject({ ok: false, status: 409 });
      expect(money.calls).toHaveLength(0); expect(written).toEqual([]);
    }
    db.reset(); db.seed("missions", [{ ...ordinary(), id: "msn_oddplan0001", plan: { addon: "x", stages: [] } }]);
    const { client, money, written } = makeClient(db);
    expect(await approve(client, "msn_oddplan0001")).toMatchObject({ ok: false, status: 409 });
    expect(money.calls).toHaveLength(0); expect(written).toEqual([]);
  });
  it("the other refusals come first and are unchanged: a guest 401, an unverified account 403, another customer's row 404", async () => {
    const row = addonRowOf({ status: "plan_ready", kind: "review", base: 1 });
    db.seed("missions", [row]);
    const { client } = makeClient(db);
    expect(await approveForCustomer(client, { id: row.id, userId: ME, isGuest: true, emailVerified: false })).toMatchObject({ ok: false, status: 401 });
    expect(await approveForCustomer(client, { id: row.id, userId: ME, isGuest: false, emailVerified: false })).toMatchObject({ ok: false, status: 403 });
    expect(await approveForCustomer(client, { id: row.id, userId: "u-2", isGuest: false, emailVerified: true })).toMatchObject({ ok: false, status: 404 });
  });
});

describe("TEST 18: an ordinary mission is approved exactly as before", () => {
  it("reserves through the existing functions once; a double click reserves once", async () => {
    db.seed("missions", [ordinary()]);
    const { client, money } = makeClient(db);
    const first = await approve(client, "msn_ready0001");
    expect(first.ok).toBe(true);
    expect(await approve(client, "msn_ready0001")).toMatchObject({ ok: false, status: 409 });
    expect(money.calls.map((c) => c.name)).toEqual(["create_quote_atomic", "accept_quote_atomic", "claim_job_chunk"]);
    expect(money.ledger.filter((l) => l.type === "reserve")).toHaveLength(1);
    expect(db.rows("missions")[0]).toMatchObject({ status: "approved", approved_by: ME });
  });
});
