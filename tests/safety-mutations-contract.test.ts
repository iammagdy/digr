import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addonRowOf, objectsOf, sizedVersion } from "./helpers/reviewQuoteWorld";
import { cleanMutants, loadMutant } from "./helpers/mutants";
import { solo, type Row } from "./helpers/scheduledWorld";

/**
 * SAFETY ROUND, MUTATION TESTS for the approval contract: each test removes ONE check of the approval guard from a copy of the source (tests/helpers/mutants.ts) and runs the case the check exists for; the guard must then let through what it must refuse.
 * The real code is never modified.
 */
afterAll(cleanMutants);
const GUARD = "src/lib/agentMission/stage4/approvalGuard.ts";
const MISSION = "msn_5851abc92a1e6645a9cd";
const ME = "u-1";
let ONE: Record<string, string>;
beforeAll(() => { ONE = objectsOf(sizedVersion(6, 3)); });
const waiting = (over: Record<string, unknown> = {}): Row => ({ ...addonRowOf({ status: "plan_ready", kind: "review", base: 1, cells: 18 }), request_text: "طلب", job_id: null, approved_at: null, ...over });
const opts = (objects: Record<string, string>, seed: Row[]) => ({ objects, balance: 100_000, seed: [{ id: MISSION, user_id: ME, status: "completed", plan: { stages: [] }, delivered_units: 60 }, ...seed] });

describe("MUTATION: the approval guard's checks", () => {
  it("without the comparison with the approved points, a customer who approved a DIFFERENT price is let through", async () => {
    const m = await loadMutant(GUARD, [{ from: "if (input.expectedPoints !== undefined && (typeof input.expectedPoints !== \"number\" || !Number.isInteger(input.expectedPoints) || input.expectedPoints !== priced.holdPoints)) return no(409, \"price_mismatch\", ADDON_APPROVE_MESSAGES_AR.plan_changed);", to: "" }]);
    const row = waiting();
    const { value } = await solo<any>(opts(ONE, [row]), (c) => m.module.guardApproval(c, { id: row.id, userId: ME, expectedPoints: 1 }));
    expect(value).toEqual({ ok: true });
  });
  it("without the server's price check, a TAMPERED stored price is let through", async () => {
    const m = await loadMutant(GUARD, [{ from: "if (!priced.ok) return no(409, \"price_mismatch\", priced.code === \"too_large\" ? ADDON_APPROVE_MESSAGES_AR.too_large : ADDON_APPROVE_MESSAGES_AR.plan_changed);", to: "" }, { from: "input.expectedPoints !== priced.holdPoints", to: "false" }]);
    const row = waiting();
    (row.plan as any).addon.pricing.holdPoints = 999; (row.plan as any).addon.pricing.estimatePoints = 999;
    const { value } = await solo<any>(opts(ONE, [row]), (c) => m.module.guardApproval(c, { id: row.id, userId: ME }));
    expect(value).toEqual({ ok: true });
  });
  it("without the read of the published version, a request against a version that is NOT in storage is let through", async () => {
    const m = await loadMutant(GUARD, [{ from: "if (!read.ok) return read.status === 404 ? no(409, \"version_changed\", VERSION_CHANGED_AR) : no(503, \"unavailable\", NOTHING_HELD_AR);", to: "" }, { from: "if (addon.kind !== \"review\" && read.latest !== addon.baseVersion)", to: "if (false)" }, { from: "if (addon.kind === \"review\" && reviewCellsOf(read.version) !== addon.pricing.cells)", to: "if (false)" }]);
    const row = waiting();
    const { value } = await solo<any>(opts({}, [row]), (c) => m.module.guardApproval(c, { id: row.id, userId: ME }));
    expect(value).toEqual({ ok: true });
  });
  it("without the cell-count check, a review priced for a DIFFERENT number of cells than the file holds is let through", async () => {
    const m = await loadMutant(GUARD, [{ from: "if (addon.kind === \"review\" && reviewCellsOf(read.version) !== addon.pricing.cells) return no(409, \"version_changed\", VERSION_CHANGED_AR);", to: "" }]);
    const row = waiting({ plan: (addonRowOf({ status: "plan_ready", kind: "review", base: 1, cells: 5000 }) as any).plan });
    const { value } = await solo<any>(opts(ONE, [row]), (c) => m.module.guardApproval(c, { id: row.id, userId: ME }));
    expect(value).toEqual({ ok: true });
  });
  it("without the owner check, another customer's request is let through", async () => {
    const m = await loadMutant(GUARD, [{ from: "const addon = row && row.user_id === input.userId ? readAddonPlan(row.plan) : null;", to: "const addon = row ? readAddonPlan(row.plan) : null;" }]);
    const row = waiting();
    const { value } = await solo<any>(opts(ONE, [row]), (c) => m.module.guardApproval(c, { id: row.id, userId: "u-2" }));
    expect(value.ok).toBe(false); // the store is scoped to the user, so the later read finds nothing: the owner check is ALSO enforced by the store's user filter (two layers)
    expect(value.reason).not.toBe("not_found");
  });
});
