import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addonId } from "../src/lib/agentMission/addonSettlement";
import { OPEN_STATUSES, createAddonRow, type AddonRequest, type AddonRowInsert, type AddonRowLike, type AddonRowStore, type CreateAddonResult } from "../src/lib/agentMission/stage4/addonRow";
import { editPricing, reviewPricing, USER } from "./helpers/addonWorld";

/**
 * MONEY PR 7d, PHASE 2B-2 TASK 3: TWO OPEN ADD-ONS ON ONE FILE MUST BE IMPOSSIBLE EVEN WHEN TWO REQUESTS ARE CREATED AT THE SAME TIME (docs/MONEY-PR-7A.md section 16.2).
 * The id of an add-on is deterministic from (mission, base version, attempt): two clicks on the SAME version make the same id and the primary key refuses the second. But two requests on DIFFERENT versions (a review of version 1 and a review of version 2 from two tabs)
 * have different ids, and `canCreateAddon` is a read followed by an insert: both read «no open add-on», both insert, and two open requests exist (decision D10 broken). The fix needs no migration: after its insert the creator READS the open add-ons again; when more than one is open,
 * every one but a single deterministic WINNER (a started one first, then the lowest id) is cancelled by a compare-and-set that only matches an unpaid `plan_ready` row, and a creator whose own row lost is told «open add-on».
 * The test below runs EVERY interleaving of the store calls of two concurrent creators (each store call is atomic, as one database statement is) and checks the end state.
 */
const fetchSpy = vi.fn(() => { throw new Error("a real call was attempted"); });
beforeEach(() => { vi.stubGlobal("fetch", fetchSpy); });
afterEach(() => vi.unstubAllGlobals());

const MISSION = "msn_5851abc92a1e6645a9cd";
const REVIEW: AddonRequest = { kind: "review" };
const EDIT: AddonRequest = { kind: "edit", edit: { kind: "add_column", sheet: "الفيديوهات", titleAr: "عدد المشاهدات", rowIds: ["r1", "r2"] } };

type Row = AddonRowLike & { user_id?: string; request_text?: string };
type Pending = { client: number; exec: () => unknown; resolve: (v: unknown) => void };
type Maker = (store: AddonRowStore) => Promise<CreateAddonResult>;

const review = (baseVersion: number, latestVersion = 2): Maker => (store) =>
  createAddonRow(store, { userId: USER, of: MISSION, kind: "review", baseVersion, latestVersion, request: REVIEW, pricing: reviewPricing(1000), requestText: "طلب مراجعة الملف" });
const edit = (baseVersion: number): Maker => (store) =>
  createAddonRow(store, { userId: USER, of: MISSION, kind: "edit", baseVersion, latestVersion: baseVersion, request: EDIT, pricing: editPricing(2, 0.0005), requestText: "ضيف عمود عدد المشاهدات" });
const settle = () => new Promise<void>((r) => setImmediate(r));

/** Runs the creators together over ONE table. Every store call of every creator waits; the scheduler runs exactly one waiting call at a time (atomically) and `choices` says which when more than one waits. */
async function runSchedule(makers: Maker[], choices: number[], initial: Row[] = [], staleFirstRead: ReadonlySet<number> = new Set()) {
  const rows = new Map<string, Row>(initial.map((r) => [r.id, { ...r }]));
  const pending: Pending[] = [];
  const staleUsed = new Set<number>();
  const storeFor = (client: number): AddonRowStore => {
    const call = <T,>(exec: () => T) => new Promise<T>((resolve) => { pending.push({ client, exec, resolve: resolve as (v: unknown) => void }); });
    return {
      listFor: (of) => call(() => {
        if (staleFirstRead.has(client) && !staleUsed.has(client)) { staleUsed.add(client); return [] as Row[]; }
        return [...rows.values()].filter((r) => (r.plan as any)?.addon?.of === of).map((r) => ({ ...r }));
      }),
      insert: (row: AddonRowInsert) => call(() => { if (rows.has(row.id)) return { ok: false as const, duplicate: true }; rows.set(row.id, { ...row }); return { ok: true as const }; }),
      cancelUnpaid: (id: string) => call(() => { const r = rows.get(id); if (!r || r.status !== "plan_ready") return false; r.status = "cancelled"; return true; }),
    };
  };
  const done = makers.map(() => false);
  const results = makers.map((m, i) => m(storeFor(i)).then((v) => { done[i] = true; return v; }));
  const widths: number[] = [];
  const picks: number[] = [];
  let guard = 0;
  while (!done.every(Boolean)) {
    if (++guard > 200) throw new Error("the scheduler did not finish");
    await settle();
    if (pending.length === 0) continue;
    let pick = 0;
    if (pending.length > 1) { pick = (choices[widths.length] ?? 0) % pending.length; widths.push(pending.length); picks.push(pick); }
    const [p] = pending.splice(pick, 1);
    p.resolve(p.exec());
  }
  return { rows, results: await Promise.all(results), widths, picks };
}

/** Every schedule of the creators (depth-first over the choice points), each one checked by `check`. Returns how many were run. */
async function explore(makers: Maker[], check: (out: Awaited<ReturnType<typeof runSchedule>>) => void, initial: Row[] = [], stale: ReadonlySet<number> = new Set()): Promise<number> {
  const stack: number[][] = [[]];
  let runs = 0;
  while (stack.length > 0) {
    const prefix = stack.pop()!;
    const out = await runSchedule(makers, prefix, initial, stale);
    runs += 1;
    check(out);
    for (let i = prefix.length; i < out.widths.length; i += 1) for (let alt = 1; alt < out.widths[i]; alt += 1) stack.push([...out.picks.slice(0, i), alt]);
    if (runs > 20_000) throw new Error("too many schedules");
  }
  return runs;
}
const openOf = (rows: Map<string, Row>) => [...rows.values()].filter((r) => (OPEN_STATUSES as ReadonlyArray<string>).includes(r.status));

function endStateIsSafe(out: Awaited<ReturnType<typeof runSchedule>>, label: string) {
  const open = openOf(out.rows);
  expect(open, `${label}: exactly one open add-on at the end`).toHaveLength(1);
  for (const r of out.rows.values()) if (!open.includes(r)) expect(r.status, `${label}: a row that is not the open one is cancelled`).toBe("cancelled");
  expect(out.results.some((r) => r.ok), `${label}: one creator succeeded`).toBe(true);
  for (const r of out.results) if (!r.ok) {
    expect(r.reason, label).toBe("open_addon");
    expect(out.rows.has(r.existingId ?? ""), `${label}: the refusal names a row that exists`).toBe(true);
  }
  expect(out.results.filter((r) => r.ok && r.row.id === open[0].id), `${label}: the open row was made by exactly one creator`).toHaveLength(1);
}

describe("TEST 10: concurrent creation never leaves two open requests, in ANY interleaving", () => {
  it("a review of version 1 and a review of version 2 created at the same time (different ids): one open request at the end", async () => {
    const runs = await explore([review(1), review(2)], (out) => endStateIsSafe(out, "v1+v2"));
    expect(runs).toBeGreaterThan(30); // the exploration is real: many interleavings, not one
  }, 120_000);
  it("the same version twice (the same id): the primary key refuses the second, one row, in every interleaving", async () => {
    const runs = await explore([review(1), review(1)], (out) => {
      expect(out.rows.size).toBe(1);
      endStateIsSafe(out, "v1+v1");
    });
    expect(runs).toBeGreaterThan(5);
  }, 120_000);
  it("a review of version 1 and an edit of the latest version 2: one open request in every interleaving", async () => {
    await explore([review(1), edit(2)], (out) => endStateIsSafe(out, "review+edit"));
  }, 120_000);
  it("three creators (versions 1, 2 and 3): one open request in every one of 300 pseudo-random interleavings", async () => {
    let seed = 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; };
    for (let n = 0; n < 300; n += 1) {
      const choices = Array.from({ length: 40 }, () => rnd() % 3);
      endStateIsSafe(await runSchedule([review(1, 3), review(2, 3), review(3, 3)], choices), `random ${n}`);
    }
  }, 120_000);
  it("a creator that read a STALE «nothing is open» while another add-on was already STARTED never touches the started one and cancels itself", async () => {
    const started: Row = { id: addonId(MISSION, 2, 1), status: "approved", user_id: USER, plan: { addon: { v: 1, kind: "edit", of: MISSION, baseVersion: 2, newVersion: 3, attempt: 1, request: EDIT, pricing: editPricing(2, 0.0005) } } };
    const out = await runSchedule([review(1, 2)], [], [started], new Set([0]));
    expect(out.rows.get(started.id)!.status).toBe("approved");
    expect(out.rows.get(addonId(MISSION, 1, 1))!.status).toBe("cancelled");
    expect(out.results[0]).toMatchObject({ ok: false, reason: "open_addon", existingId: started.id });
    expect(openOf(out.rows).map((r) => r.id)).toEqual([started.id]);
  });
});

describe("what did not change", () => {
  it("a single creator with nothing else open: one row, plan_ready, returned as before", async () => {
    const out = await runSchedule([review(1)], []);
    expect(out.results[0]).toMatchObject({ ok: true });
    expect([...out.rows.values()].map((r) => [r.id, r.status])).toEqual([[addonId(MISSION, 1, 1), "plan_ready"]]);
  });
  it("an add-on that is already open is refused BEFORE any insert (the read still comes first)", async () => {
    const open: Row = { id: addonId(MISSION, 1, 1), status: "plan_ready", user_id: USER, plan: { addon: { v: 1, kind: "review", of: MISSION, baseVersion: 1, newVersion: null, attempt: 1, request: REVIEW, pricing: reviewPricing(1000) } } };
    const out = await runSchedule([review(2)], [], [open]);
    expect(out.results[0]).toMatchObject({ ok: false, reason: "open_addon", existingId: open.id });
    expect(out.rows.size).toBe(1);
  });
});
