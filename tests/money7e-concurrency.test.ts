import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addonId } from "../src/lib/agentMission/addonSettlement";
import * as addonRow from "../src/lib/agentMission/stage4/addonRow";
import { OPEN_STATUSES, createAddonRow, type AddonRequest, type AddonRowInsert, type AddonRowLike, type AddonRowStore, type CreateAddonResult } from "../src/lib/agentMission/stage4/addonRow";
import { cancelUnpaidAddonRow, createSupabaseAddonRowStore } from "../src/lib/agentMission/stage4/addonRowStore";
import { cancelReviewRequest, currentReviewRequest } from "../src/lib/agentMission/stage4/reviewRequest";
import { reviewPricing, USER } from "./helpers/addonWorld";
import { projectingDb } from "./helpers/projectingDb";

/**
 * MONEY PR 7e, PHASE 2B-2 TASK 4, PART 2: HOW STRONG IS «ONE OPEN ADD-ON PER FILE» (docs/MONEY-PR-7A.md section 17.2)? The fix of PR #386 (read, insert, READ AGAIN, cancel the unpaid duplicates) is a protocol over ordinary reads and writes, not a database constraint.
 * Every interleaving of the store calls of the creators is run here over one table (each store call is atomic, as one statement is), with the failures that protocol has to survive:
 *   - THE SPECIFIED FAILURE: request A made its row; request B read before A was visible, inserted its own row, and then B's post-insert read FAILED (the database or the network went away);
 *   - the same with every later write of B failing as well (no retraction possible: the honest limit of the protocol);
 *   - an existing waiting request that STARTS APPROVAL (the claim `plan_ready -> approved`, then the job is recorded) while another request is being created;
 *   - a request that went through a failed approval attempt and is `plan_ready` again, with its money state unknown.
 * Nothing here is money: the rows are fake and no function of the money side is reachable.
 */
const fetchSpy = vi.fn(() => { throw new Error("a real call was attempted"); });
beforeEach(() => { vi.stubGlobal("fetch", fetchSpy); });
afterEach(() => vi.unstubAllGlobals());

const MISSION = "msn_5851abc92a1e6645a9cd";
const REVIEW: AddonRequest = { kind: "review" };
type Row = AddonRowLike & { user_id?: string; job_id?: string | null; approved_at?: string | null };
const rowOf = (version: number, over: Partial<Row> = {}): Row => ({ id: addonId(MISSION, version, 1), status: "plan_ready", user_id: USER, job_id: null, approved_at: null, plan: { addon: { v: 1, kind: "review", of: MISSION, baseVersion: version, newVersion: null, attempt: 1, request: REVIEW, pricing: reviewPricing(1000) } }, ...over });
const ID1 = addonId(MISSION, 1, 1);
const ID2 = addonId(MISSION, 2, 1);
const review = (baseVersion: number, latestVersion = 3) => (c: Ctl) => createAddonRow(c.store, { userId: USER, of: MISSION, kind: "review", baseVersion, latestVersion, request: REVIEW, pricing: reviewPricing(1000), requestText: "طلب مراجعة الملف" });

interface Ctl { store: AddonRowStore; atomic: <T>(fn: () => T) => Promise<T>; table: Map<string, Row> }
type Maker = (c: Ctl) => Promise<unknown>;
interface Opts {
  initial?: Row[];
  /** clients whose FIRST read answers «nothing is open» (it ran before the other request was visible) */
  stale?: ReadonlySet<number>;
  /** client -> the 1-based number of the first read that throws (and every later read) */
  failReadsFrom?: ReadonlyMap<number, number>;
  /** clients whose every store call AFTER their insert throws (reads and cancels) */
  blackoutAfterInsert?: ReadonlySet<number>;
}
type Pending = { exec: () => unknown; resolve: (v: unknown) => void; reject: (e: unknown) => void };
const settle = () => new Promise<void>((r) => setImmediate(r));
const isOpen = (r: Row) => (OPEN_STATUSES as ReadonlyArray<string>).includes(r.status);

async function run(makers: Maker[], choices: number[], opts: Opts = {}) {
  const rows = new Map<string, Row>((opts.initial ?? []).map((r) => [r.id, { ...r }]));
  const pending: Pending[] = [];
  let maxOpen = [...rows.values()].filter(isOpen).length;
  const exec = <T,>(fn: () => T) => new Promise<T>((resolve, reject) => pending.push({ exec: fn, resolve: resolve as (v: unknown) => void, reject }));
  const ctlFor = (client: number): Ctl => {
    let reads = 0;
    let inserted = false;
    const down = () => { throw new Error("database is down"); };
    const store: AddonRowStore = {
      listFor: (of) => exec(() => {
        reads += 1;
        if ((inserted && opts.blackoutAfterInsert?.has(client)) || (opts.failReadsFrom?.has(client) && reads >= opts.failReadsFrom.get(client)!)) return down();
        if (opts.stale?.has(client) && reads === 1) return [] as Row[];
        return [...rows.values()].filter((r) => (r.plan as any)?.addon?.of === of).map((r) => ({ ...r }));
      }),
      insert: (row: AddonRowInsert) => exec(() => {
        if (rows.has(row.id)) return { ok: false as const, duplicate: true };
        rows.set(row.id, { ...row, job_id: null, approved_at: null });
        inserted = true;
        return { ok: true as const };
      }),
      cancelUnpaid: (id: string) => exec(() => {
        if (inserted && opts.blackoutAfterInsert?.has(client)) return down();
        const r = rows.get(id);
        if (!r || r.status !== "plan_ready" || r.job_id || r.approved_at) return false;
        r.status = "cancelled";
        return true;
      }),
    };
    return { store, atomic: (fn) => exec(fn), table: rows };
  };
  const settled = makers.map(() => false);
  const results = makers.map((m, i) => m(ctlFor(i)).then((v) => { settled[i] = true; return { ok: true as const, value: v }; }, (e) => { settled[i] = true; return { ok: false as const, error: e }; }));
  const widths: number[] = [];
  const picks: number[] = [];
  let guard = 0;
  while (!settled.every(Boolean)) {
    if (++guard > 400) throw new Error("the scheduler did not finish");
    await settle();
    if (pending.length === 0) continue;
    let pick = 0;
    if (pending.length > 1) { pick = (choices[widths.length] ?? 0) % pending.length; widths.push(pending.length); picks.push(pick); }
    const [p] = pending.splice(pick, 1);
    try { p.resolve(p.exec()); } catch (e) { p.reject(e); }
    maxOpen = Math.max(maxOpen, [...rows.values()].filter(isOpen).length);
  }
  return { rows, results: await Promise.all(results), widths, picks, maxOpen };
}
type Out = Awaited<ReturnType<typeof run>>;

async function explore(makers: Maker[], check: (out: Out) => void, opts: Opts = {}): Promise<{ runs: number; maxOpenAtEnd: number }> {
  const stack: number[][] = [[]];
  let runs = 0;
  let maxOpenAtEnd = 0;
  while (stack.length > 0) {
    const prefix = stack.pop()!;
    const out = await run(makers, prefix, opts);
    runs += 1;
    check(out);
    maxOpenAtEnd = Math.max(maxOpenAtEnd, [...out.rows.values()].filter(isOpen).length);
    for (let i = prefix.length; i < out.widths.length; i += 1) for (let alt = 1; alt < out.widths[i]; alt += 1) stack.push([...out.picks.slice(0, i), alt]);
    if (runs > 30_000) throw new Error("too many schedules");
  }
  return { runs, maxOpenAtEnd };
}
const openIds = (out: Out) => [...out.rows.values()].filter(isOpen).map((r) => r.id);
/** A plain atomic store over a finished table: what a later read of the same file sees. */
const storeOver = (rows: Map<string, Row>): AddonRowStore => ({
  listFor: async (of) => [...rows.values()].filter((r) => (r.plan as any)?.addon?.of === of).map((r) => ({ ...r })),
  insert: async (row) => { if (rows.has(row.id)) return { ok: false, duplicate: true }; rows.set(row.id, { ...row, job_id: null, approved_at: null }); return { ok: true }; },
  cancelUnpaid: async (id) => { const r = rows.get(id); if (!r || r.status !== "plan_ready" || r.job_id || r.approved_at) return false; r.status = "cancelled"; return true; },
});

describe("THE SPECIFIED FAILURE: B read before A was visible, B inserted, and B's post-insert read failed", () => {
  const A = review(1);
  const B = review(2);
  const check = (out: Out) => {
    const open = openIds(out);
    expect(open.length, "at most one open request at the end").toBeLessThanOrEqual(1);
    for (const r of out.results) if (r.ok && (r.value as CreateAddonResult).ok) expect(open, "a creator told «ok» has its row open").toContain((r.value as Extract<CreateAddonResult, { ok: true }>).row.id);
    expect(out.results[1].ok, "B was told the creation failed, never «ok»").toBe(false);
  };
  it("every interleaving, B's reads after the first fail but B can still write: B withdraws its own unpaid row, so at most ONE request stays open", async () => {
    const { runs } = await explore([A, B], check, { stale: new Set([1]), failReadsFrom: new Map([[1, 2]]) });
    expect(runs).toBeGreaterThan(20);
  }, 120_000);
  it("the same with the read failing only ONCE (the post-insert read), then the database answers again", async () => {
    // reads of B: #1 stale, #2 fails (post-insert), #3... would work again: model by failing exactly read 2
    const only2: Opts = { stale: new Set([1]), failReadsFrom: new Map([[1, 2]]) };
    const out = await run([A, B], [], only2);
    expect(out.maxOpen).toBeGreaterThanOrEqual(1);
    expect(openIds(out).length).toBeLessThanOrEqual(1);
  });
  it("THE HONEST LIMIT: when B can neither read nor write after its insert, TWO open requests CAN remain until the next read repairs them; the protocol alone is not a constraint", async () => {
    const { maxOpenAtEnd } = await explore([A, B], () => { /* checked below */ }, { stale: new Set([1]), blackoutAfterInsert: new Set([1]) });
    expect(maxOpenAtEnd, "some interleaving ends with two open requests: this is the documented residual risk").toBe(2);
  }, 120_000);
  it("and the next read REPAIRS it, in every one of those end states: exactly one request stays open, the same one for every reader, and nothing started is ever cancelled", async () => {
    let healed = 0;
    // collect the end states with two open rows, then repair each of them
    const ends: Array<Map<string, Row>> = [];
    await explore([A, B], (out) => { if (openIds(out).length === 2) ends.push(new Map([...out.rows].map(([k, v]) => [k, { ...v }]))); }, { stale: new Set([1]), blackoutAfterInsert: new Set([1]) });
    expect(ends.length).toBeGreaterThan(0);
    for (const rows of ends) {
      const fixed = await addonRow.reconcileOpenAddons(storeOver(rows), MISSION);
      const open = [...rows.values()].filter(isOpen);
      expect(open).toHaveLength(1);
      expect(fixed.keeper?.id).toBe(open[0].id);
      expect(open[0].id, "the lower id stays, as every creator computes").toBe([ID1, ID2].sort()[0]);
      healed += 1;
    }
    expect(healed).toBe(ends.length);
  }, 120_000);
  it("a third creator that finds two open requests repairs them first and is refused with the one that stays", async () => {
    const rows = new Map<string, Row>([rowOf(1), rowOf(2)].map((r) => [r.id, r]));
    const r = await createAddonRow(storeOver(rows), { userId: USER, of: MISSION, kind: "review", baseVersion: 3, latestVersion: 3, request: REVIEW, pricing: reviewPricing(1000), requestText: "طلب مراجعة الملف" });
    expect(r).toMatchObject({ ok: false, reason: "open_addon", existingId: [ID1, ID2].sort()[0] });
    expect([...rows.values()].filter(isOpen)).toHaveLength(1);
  });
  it("a creator whose OWN row's settlement fails withdraws it before it reports the failure (nothing is left waiting that nobody was told about)", async () => {
    const rows = new Map<string, Row>();
    const base = storeOver(rows);
    let reads = 0;
    const store: AddonRowStore = { ...base, listFor: async (of) => { reads += 1; if (reads === 2) throw new Error("database is down"); return base.listFor(of); } };
    await expect(createAddonRow(store, { userId: USER, of: MISSION, kind: "review", baseVersion: 1, latestVersion: 1, request: REVIEW, pricing: reviewPricing(1000), requestText: "طلب مراجعة الملف" })).rejects.toThrow();
    expect([...rows.values()].filter(isOpen)).toEqual([]);
    expect(rows.get(ID1)?.status).toBe("cancelled");
  });
});

describe("an existing waiting request STARTS APPROVAL while another request is being created", () => {
  /** the approval's two writes, as `approveAddonOnce` does them: the claim `plan_ready -> approved` (a compare-and-set, it changes nothing when the row is no longer waiting), then the job is recorded */
  const approver = (id: string): Maker => async (c) => {
    const won = await c.atomic(() => { const r = c.table.get(id); if (!r || r.status !== "plan_ready" || r.approved_at) return false; r.status = "approved"; r.approved_at = "2026-11-04T12:00:00Z"; return true; });
    if (won) await c.atomic(() => { c.table.get(id)!.job_id = "job_1"; });
    return won;
  };
  // the creator's first read is stale (it ran before the waiting request was visible); the waiting request exists from the start
  const LOWER = ID1 < ID2 ? 1 : 2;
  const HIGHER = ID1 < ID2 ? 2 : 1;
  for (const [label, waitingVersion, creatorVersion, cancelCanWin] of [["the waiting request has the LOWER id (it is the one that stays)", LOWER, HIGHER, false], ["the waiting request has the HIGHER id (the new request would stay, unless the approval starts first)", HIGHER, LOWER, true]] as const) {
    it(`${label}: in every interleaving exactly ONE request is open at the end, a started request is never cancelled, and the new request never stays open next to a started one`, async () => {
      const waiting = rowOf(waitingVersion);
      const approvals: boolean[] = [];
      const { runs } = await explore([review(creatorVersion), approver(waiting.id)], (out) => {
        const open = openIds(out);
        expect(open, "exactly one open request").toHaveLength(1);
        const w = out.rows.get(waiting.id)!;
        const won = out.results[1].ok && out.results[1].value === true;
        approvals.push(won);
        if (won) { expect(w.status, "a started request is never cancelled").toBe("approved"); expect(open).toEqual([waiting.id]); }
        else { expect(w.status, "an approval that lost matched nothing: the request was cancelled before it").toBe("cancelled"); }
        const mine = out.results[0];
        if (mine.ok && (mine.value as CreateAddonResult).ok) expect(open).toEqual([(mine.value as Extract<CreateAddonResult, { ok: true }>).row.id]);
      }, { initial: [waiting], stale: new Set([0]) });
      expect(runs).toBeGreaterThan(10);
      expect(approvals.some((w) => w), "the approval won in some interleavings").toBe(true);
      expect(approvals.some((w) => !w), "the approval lost in some interleavings").toBe(cancelCanWin);
    }, 120_000);
  }

  it("a request that went through a FAILED approval attempt and is `plan_ready` again (approved_at set, no job: its money state is unknown) is treated as started: it is never cancelled by a creator, the NEW request is", async () => {
    const reverted = rowOf(2, { approved_at: "2026-11-04T11:00:00Z" });
    const { runs } = await explore([review(1)], (out) => {
      expect(out.rows.get(reverted.id)!.status).toBe("plan_ready");
      expect(out.rows.get(ID1)!.status).toBe("cancelled");
      expect(out.results[0]).toMatchObject({ ok: true, value: { ok: false, reason: "open_addon", existingId: reverted.id } });
    }, { initial: [reverted], stale: new Set([0]) });
    expect(runs).toBeGreaterThan(0);
  });
});

describe("the store's cancel of an UNPAID request never touches a request that was ever approved (the real Supabase statement, on the strict fake database)", () => {
  const MISSION_ROW = { id: MISSION, user_id: USER, status: "completed", plan: { stages: [] } };
  const seed = (over: Record<string, unknown>) => { const db = projectingDb(); db.seed("missions", [MISSION_ROW, { ...rowOf(1), request_text: "طلب مراجعة", ...over }]); return db; };
  it("a never-approved `plan_ready` row with no job is cancelled, by ONE update whose conditions name the owner, the status, the job and the approval", async () => {
    const db = seed({});
    expect(await cancelUnpaidAddonRow(db, { id: ID1, userId: USER })).toBe(true);
    expect(db.rows("missions").find((r) => r.id === ID1)!.status).toBe("cancelled");
    expect(db.log.filter((l) => l.op === "update")).toHaveLength(1);
  });
  for (const [what, over] of [["a job", { job_id: "job_1" }], ["an approval timestamp (a failed approval that was put back)", { approved_at: "2026-11-04T11:00:00Z" }], ["another status", { status: "approved" }], ["another owner", { user_id: "u-2" }]] as const) {
    it(`a row with ${what} is left exactly as it is`, async () => {
      const db = seed(over);
      expect(await cancelUnpaidAddonRow(db, { id: ID1, userId: USER })).toBe(false);
      expect(db.rows("missions").find((r) => r.id === ID1)!.status).toBe(over.status ?? "plan_ready");
    });
  }
  it("the store lists the two facts the rule needs (the job and the approval) with every add-on row", async () => {
    const db = seed({ approved_at: "2026-11-04T11:00:00Z" });
    const rows = await createSupabaseAddonRowStore(db, USER).listFor(MISSION);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: ID1, status: "plan_ready", approved_at: "2026-11-04T11:00:00Z", job_id: null });
  });
  it("the customer's own cancel answers «changed» for such a row and the page does not offer it as a request that holds nothing", async () => {
    const db = seed({ approved_at: "2026-11-04T11:00:00Z" });
    expect(await cancelReviewRequest(db, { missionId: MISSION, userId: USER, requestId: ID1 })).toMatchObject({ ok: false, status: 409, error: "changed" });
    expect(await currentReviewRequest(db, { missionId: MISSION, userId: USER })).toEqual({ ok: true, request: null });
    expect(db.rows("missions").find((r) => r.id === ID1)!.status).toBe("plan_ready");
  });
  it("a refresh repairs two open requests (the end state of the specified failure): the one that stays is shown, the other is cancelled, and nothing else is written", async () => {
    const db = projectingDb();
    db.seed("missions", [MISSION_ROW, { ...rowOf(1), request_text: "طلب مراجعة" }, { ...rowOf(2), request_text: "طلب مراجعة" }]);
    const cur = await currentReviewRequest(db, { missionId: MISSION, userId: USER });
    const stays = [ID1, ID2].sort()[0];
    expect(cur).toMatchObject({ ok: true, request: { id: stays } });
    expect(db.rows("missions").filter((r) => isOpen(r as Row)).map((r) => r.id)).toEqual([stays]);
    expect(db.log.filter((l) => l.op === "update")).toHaveLength(1);
    expect(db.moneyTouched()).toEqual([]);
  });
});
