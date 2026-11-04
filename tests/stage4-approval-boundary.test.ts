import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ADDON_MAX_HOLD_POINTS, addonChargePoints, addonJobId, addonQuoteId, approveAddonOnce, readAddonPlan, settleAddon } from "../src/lib/agentMission/addonSettlement";
import { createEditRequest, parseEditInput } from "../src/lib/agentMission/stage4/editRequest";
import { createReviewRequest } from "../src/lib/agentMission/stage4/reviewRequest";
import { objectsOf, sizedVersion } from "./helpers/reviewQuoteWorld";
import { addonRowsIn, MISSION, ME, requestClient } from "./helpers/reviewRequestWorld";
import { addonRowOf, checkAddonLedger, fakeAddonWorld, USER } from "./helpers/addonWorld";
import { firstVersionFromCells } from "../src/lib/agentMission/stage4/versions";

/**
 * STAGE D: THE FINANCIAL APPROVAL BOUNDARY (docs/STAGE-4-APPROVAL-BOUNDARY.md). FAKE-ONLY CHARACTERIZATION: nothing here exposes, wires or activates an approval route and nothing touches a database or a provider. It checks, with the EXISTING money core (`approveAddonOnce`, `settleAddon`)
 * on the hardened money fake, what an approval of a request made by the Stage A to C code would do, so the owner can see the contract the missing route must keep: the price the customer was shown is exactly the hold that is reserved; nothing is charged at approval; a settled typed edit is
 * charged within its hold; and what the approval path does NOT check (another open add-on, whether the kind can be run) is shown as it is, not hidden. No existing assertion of any other file is changed.
 */
const fetchSpy = vi.fn(() => { throw new Error("a real call was attempted"); });
beforeEach(() => { vi.stubGlobal("fetch", fetchSpy); fetchSpy.mockClear(); });
afterEach(() => vi.unstubAllGlobals());

const SHEET = "العملاء";
const base = () => firstVersionFromCells({ missionId: MISSION, createdAt: "2026-11-02T12:00:00.000Z", cells: { [SHEET]: [["المعرّف", "الاسم", "الهاتف"], ["a_1", "أحمد", "0100"], ["a_2", "سارة", "0111"], ["a_3", "منى", "0122"]] } });
const editOf = (raw: unknown) => { const p = parseEditInput(raw); if (!p.ok) throw new Error("not an input"); return p; };

/** A request made by the real creation code, copied into the money world exactly as the table holds it. */
async function requestMadeBy(kind: "review" | "rename" | "cells" | "rows") {
  const v = base();
  const w = requestClient(objectsOf(v));
  let shown: { holdPoints: number; estimatePoints: number } | { holdPoints: number; estimatePoints: number };
  if (kind === "review") {
    const r = await createReviewRequest(w, { missionId: MISSION, userId: ME, version: 1 });
    if (!r.ok) throw new Error(r.error);
    shown = { holdPoints: r.request.points, estimatePoints: r.request.points };
  } else {
    const raw = kind === "rename" ? { kind: "rename_column", sheet: SHEET, from: "الهاتف", to: "الموبايل" }
      : kind === "cells" ? { kind: "set_cells", sheet: SHEET, cells: [{ row: 1, column: "الاسم", value: "محمد" }, { row: 2, column: "الهاتف", value: "0199" }] }
      : { kind: "add_rows", sheet: SHEET, rows: [{ values: { "الاسم": "هالة", "الهاتف": "0133" } }] };
    const r = await createEditRequest(w, { missionId: MISSION, userId: ME, version: 1, edit: editOf(raw) });
    if (!r.ok) throw new Error(r.error);
    shown = { holdPoints: r.request.holdPoints, estimatePoints: r.request.estimatePoints };
  }
  const row = addonRowsIn(w)[0];
  const money = fakeAddonWorld({ balance: 100_000 });
  money.missions.set(row.id, JSON.parse(JSON.stringify(row)));
  return { row, money, shown };
}

describe("the price the customer was shown is exactly what an approval would reserve", () => {
  for (const kind of ["review", "rename", "cells", "rows"] as const) it(`${kind}: res_<job> = -(the hold shown), nothing else moves at approval`, async () => {
    const { row, money, shown } = await requestMadeBy(kind);
    const out = await approveAddonOnce(money.client, { id: row.id, actorId: ME, expectUserId: ME });
    expect(out).toMatchObject({ ok: true, holdPoints: shown.holdPoints });
    if (!out.ok) throw new Error("not ok");
    const own = money.ledger.filter((r) => r.job_id === out.jobId);
    expect(own).toEqual([expect.objectContaining({ id: `res_${out.jobId}`, type: "reserve", delta: -shown.holdPoints })]);
    expect(money.balance()).toBe(100_000 - shown.holdPoints);
    expect(shown.holdPoints).toBeLessThanOrEqual(ADDON_MAX_HOLD_POINTS);
    expect(out.quoteId).toBe(addonQuoteId(row.id));
    expect(out.jobId).toBe(addonJobId(out.quoteId));
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("before approval there is no ledger row, no job and no quote at all: creating the request is free", async () => {
    const { money } = await requestMadeBy("cells");
    expect([money.ledger.filter((r) => r.type !== "topup"), [...money.jobs.keys()], [...money.quotes.keys()], money.calls]).toEqual([[], [], [], []]);
  });
  it("for a typed edit the estimate shown, the most that may be held and the charge are all the 100-point minimum (no provider cost exists to add to it)", async () => {
    for (const kind of ["rename", "cells", "rows"] as const) {
      const { shown } = await requestMadeBy(kind);
      expect(shown).toEqual({ estimatePoints: 100, holdPoints: 100 });
    }
  });
});

describe("settling an approved typed edit: within the hold, never negative, once", () => {
  for (const kind of ["rename", "cells", "rows"] as const) it(`${kind}: filled = requested, no provider cost: the charge is the 100-point minimum, at most the hold, at most what was shown as the maximum`, async () => {
    const { row, money, shown } = await requestMadeBy(kind);
    const out = await approveAddonOnce(money.client, { id: row.id, actorId: ME });
    if (!out.ok) throw new Error("not ok");
    const plan = readAddonPlan(row.plan)!;
    const settled = await settleAddon(money.client, { kind: "edit", jobId: out.jobId, holdPoints: out.holdPoints, realCostUsd: 0, filled: plan.pricing.requested, requested: plan.pricing.requested, settings: plan.pricing.settings });
    expect(settled.result.ok).toBe(true);
    expect(settled.chargePoints).toBe(addonChargePoints({ realCostUsd: 0, filled: plan.pricing.requested, requested: plan.pricing.requested, holdPoints: out.holdPoints, settings: plan.pricing.settings }));
    expect(settled.chargePoints).toBe(100);
    expect(settled.chargePoints).toBeLessThanOrEqual(shown.holdPoints);
    expect(checkAddonLedger(money, out.jobId, { reserved: out.holdPoints, charged: settled.chargePoints })).toEqual([]);
    expect(money.balance()).toBe(100_000 - settled.chargePoints);
    expect(money.balance()).toBeGreaterThanOrEqual(0);
    // settling again moves nothing more
    await settleAddon(money.client, { kind: "edit", jobId: out.jobId, holdPoints: out.holdPoints, realCostUsd: 0, filled: plan.pricing.requested, requested: plan.pricing.requested, settings: plan.pricing.settings });
    expect(checkAddonLedger(money, out.jobId, { reserved: out.holdPoints, charged: 100 })).toEqual([]);
  });
  it("a review is charged its exact hold when its report is stored and released whole when it is not", async () => {
    const stored = await requestMadeBy("review");
    const a = await approveAddonOnce(stored.money.client, { id: stored.row.id, actorId: ME });
    if (!a.ok) throw new Error("not ok");
    await settleAddon(stored.money.client, { kind: "review", jobId: a.jobId, holdPoints: a.holdPoints, reportStored: true });
    expect(checkAddonLedger(stored.money, a.jobId, { reserved: a.holdPoints, charged: a.holdPoints })).toEqual([]);
    const none = await requestMadeBy("review");
    const b = await approveAddonOnce(none.money.client, { id: none.row.id, actorId: ME });
    if (!b.ok) throw new Error("not ok");
    await settleAddon(none.money.client, { kind: "review", jobId: b.jobId, holdPoints: b.holdPoints, reportStored: false });
    expect(checkAddonLedger(none.money, b.jobId, { reserved: b.holdPoints, charged: "none" })).toEqual([]);
    expect(none.money.balance()).toBe(100_000);
  });
  it("a customer whose balance is below the shown hold is refused before anything is written", async () => {
    const { row, shown } = await requestMadeBy("cells");
    const poor = fakeAddonWorld({ balance: shown.holdPoints - 1 });
    poor.missions.set(row.id, JSON.parse(JSON.stringify(row)));
    const out = await approveAddonOnce(poor.client, { id: row.id, actorId: ME, expectUserId: ME });
    expect(out).toMatchObject({ ok: false, status: 402 });
    expect(poor.ledger.filter((r) => r.type !== "topup")).toEqual([]);
    expect(poor.missions.get(row.id)!.status).toBe("plan_ready");
  });
});

describe("what the approval path does NOT check (a documented boundary, shown as it is)", () => {
  it("FINDING: it does not look at other open add-ons of the file; the creation protocol is the only thing that keeps «one open request per file». An approval route MUST run reconcileOpenAddons first and refuse when another request is open or started", async () => {
    // two unpaid rows of one file (what two creators leave if the protocol's reads and writes both fail after the insert; see docs/STAGE-4-CUSTOMER-WORKFLOW.md and Stage E)
    const w = fakeAddonWorld({ balance: 100_000 });
    const one = addonRowOf({ baseVersion: 1 });
    const two = addonRowOf({ baseVersion: 2 });
    w.missions.set(one.id, one); w.missions.set(two.id, two);
    const first = await approveAddonOnce(w.client, { id: one.id, actorId: USER });
    const other = await approveAddonOnce(w.client, { id: two.id, actorId: USER });
    // both are approved: two jobs and two reserves for one file. Nothing in approveAddonOnce prevents it.
    expect([first.ok, other.ok]).toEqual([true, true]);
    expect(w.ledger.filter((r) => r.type === "reserve")).toHaveLength(2);
  });
  it("FINDING: it does not check that the kind can be RUN. A hand-written add-on that needs a lookup (a new column with no recipe) would be held; the worker would then fill nothing and release it whole. The request modules never create such a row, so the route must approve only rows they made", async () => {
    const a = await requestMadeBy("rename");
    const plan = JSON.parse(JSON.stringify(a.row.plan));
    plan.addon.request = { kind: "edit", edit: { kind: "add_column", sheet: SHEET, titleAr: "العنوان", rowIds: ["a_1"] } };
    a.money.missions.get(a.row.id)!.plan = plan;
    const out = await approveAddonOnce(a.money.client, { id: a.row.id, actorId: ME });
    expect(out.ok).toBe(true);
    // the hold was taken; settling it with nothing filled releases everything (charge 0), as the worker would
    if (!out.ok) throw new Error("not ok");
    await settleAddon(a.money.client, { kind: "edit", jobId: out.jobId, holdPoints: out.holdPoints, realCostUsd: 0, filled: 0, requested: 1 });
    expect(checkAddonLedger(a.money, out.jobId, { reserved: out.holdPoints, charged: "none" })).toEqual([]);
  });
  it("it never creates, cancels or reads a request by itself: it needs the row to be the customer's own, plan_ready, and priced by code again (a stored price that is not the code's is refused with nothing written)", async () => {
    const { row, money } = await requestMadeBy("rename");
    money.missions.get(row.id)!.plan.addon.pricing.holdPoints += 1;
    const out = await approveAddonOnce(money.client, { id: row.id, actorId: ME, expectUserId: ME });
    expect(out).toMatchObject({ ok: false, status: 409, code: "plan_changed" });
    expect(money.ledger.filter((r) => r.type !== "topup")).toEqual([]);
    const stranger = await requestMadeBy("rename");
    expect(await approveAddonOnce(stranger.money.client, { id: stranger.row.id, actorId: "u-2", expectUserId: "u-2" })).toMatchObject({ ok: false, status: 404 });
  });
});

describe("the boundary in the source: no route, no component and no worker path can approve", () => {
  const ROOT = path.resolve(__dirname, "..");
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => (n === "node_modules" || n.startsWith(".") ? [] : statSync(path.join(dir, n)).isDirectory() ? walk(path.join(dir, n)) : /\.(ts|tsx)$/.test(n) ? [path.join(dir, n)] : []));
  const rel = (f: string) => path.relative(ROOT, f).split(path.sep).join("/");
  it("approveAddonOnce is referenced by its own file only (production); the route files do not even contain the word", () => {
    const hits = [...walk(path.join(ROOT, "src")), ...walk(path.join(ROOT, "agent", "src"))].filter((f) => /approveAddonOnce/.test(readFileSync(f, "utf8"))).map(rel);
    expect(hits).toEqual(["src/lib/agentMission/addonSettlement.ts"]);
    for (const f of walk(path.join(ROOT, "src", "app", "api", "missions"))) expect(readFileSync(f, "utf8"), rel(f)).not.toMatch(/approveAddon|accept_quote_atomic|create_quote_atomic|reserve_credits_atomic/);
  });
  it("no customer-facing Stage 4 component sends an approval: no «approve» action or url in its code, and no call of a money function", () => {
    const code = (f: string) => readFileSync(path.join(ROOT, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    const files = [...["ReviewQuote", "ReviewReport", "EditRequestCard", "FileWorkflow", "VersionList"].map((f) => `src/components/mission/${f}.tsx`), ...readdirSync(path.join(ROOT, "src/lib/agentMission/stage4")).filter((n) => /Client\.ts$/.test(n)).map((n) => `src/lib/agentMission/stage4/${n}`)];
    expect(files.length).toBeGreaterThanOrEqual(9);
    for (const f of files) {
      const src = code(f);
      expect(src, f).not.toMatch(/["']approve["']|\/approve|approveAddon|approveMission|accept_quote_atomic|reserve_credits_atomic|\.rpc\(/);
    }
  });
  it("the Stage 4 flags that would expose a paid route are not set in this environment", () => {
    expect([process.env.DIGER_STAGE4_REVIEW, process.env.DIGER_STAGE4_EDITS, process.env.DIGER_STAGE4_VERSIONS]).toEqual([undefined, undefined, undefined]);
  });
});

void sizedVersion;
