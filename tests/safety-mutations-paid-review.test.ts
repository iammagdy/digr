import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addonJobId, addonQuoteId } from "../src/lib/agentMission/addonSettlement";
import { createSupabaseAddonRowStore } from "../src/lib/agentMission/stage4/addonRowStore";
import { applyEditRequest } from "../src/lib/agentMission/stage4/editVersion";
import type { FileVersion } from "../src/lib/agentMission/stage4/versions";
import { reviewCard } from "../src/lib/agentMission/stage4/addonQuote";
import { cleanMutants, loadMutant } from "./helpers/mutants";
import { solo, type Row, type World } from "./helpers/scheduledWorld";
import { addonRowOf, objectsOf, sizedVersion } from "./helpers/reviewQuoteWorld";

/**
 * SAFETY ROUND, MUTATION TESTS for fix B: each test removes ONE protection from a copy of the source (tests/helpers/mutants.ts) and runs the scenario it exists for; the property must then BREAK (a second paid review is allowed, an unprovable state is read as free, a published
 * report is not shown free, the approval guard lets it through). If a refactor moves the protection, the mutation no longer applies and the test fails loudly. The real code is never modified.
 */
afterAll(cleanMutants);
const PAID = "src/lib/agentMission/stage4/paidReview.ts";
const ROW = "src/lib/agentMission/stage4/addonRow.ts";
const GUARD = "src/lib/agentMission/stage4/approvalGuard.ts";
const MISSION = "msn_5851abc92a1e6645a9cd";
const ME = "u-1";
let ONE: Record<string, string>; let v1: FileVersion;
beforeAll(() => { v1 = sizedVersion(6, 3); ONE = objectsOf(v1); void applyEditRequest; });

const failedReview = (): Row => { const r = addonRowOf({ status: "failed", kind: "review", base: 1 }); return { ...r, request_text: "طلب مراجعة", approved_at: "2026-11-03T09:00:00.000Z", error: "charged_not_published", charged_points: 100, job_id: addonJobId(addonQuoteId(r.id)) }; };
const state = (row: Row, kind: "charged" | "unknown") => (w: World): void => {
  const jobId = addonJobId(addonQuoteId(row.id as string));
  w.money.jobs.set(jobId, { id: jobId, user_id: ME, status: "completed", reserved_credits: 100, charged_credits: 100, unit_price: 1, delivered_units: 100, target_volume_max: 100, step: 1, lease_until: null, result_file_id: null, accumulated_cost_usd: 0, current_cursor: "completed", endpoint_id: "agent-review", target_volume_min: 1, error_message: null });
  w.money.ledger.push({ id: `res_${jobId}`, delta: -100, type: "reserve", job_id: jobId, user_id: ME }, { id: `rel_${jobId}`, delta: 100, type: "release", job_id: jobId, user_id: ME });
  if (kind === "charged") w.money.ledger.push({ id: `chg_${jobId}`, delta: -100, type: "charge", job_id: jobId, user_id: ME });
  else w.money.ledger.find((l) => l.id === `rel_${jobId}`)!.delta = 7; // contradicts the job: unknown
};
const opts = (seed: Row[], setup: (w: World) => void, objects = ONE) => ({ objects, balance: 100_000, seed: [{ id: MISSION, user_id: ME, status: "completed", plan: { stages: [] }, delivered_units: 60 }, ...seed], setup });
const rowsOf = (rows: Map<string, Row>) => [...rows.values()].filter((r) => r.plan?.addon);

describe("MUTATION: fix B (no second paid review while the first charged review is unresolved)", () => {
  it("if a CHARGED earlier review were not counted, the verdict would be «clear» and a second paid review would be allowed", async () => {
    const m = await loadMutant(PAID, [{ from: 'if (state.kind === "charged") return { kind: "unresolved", id: r.id, reason: "charged" };', to: "" }]);
    const first = failedReview();
    const { value } = await solo<any>(opts([first], state(first, "charged")), (c) => m.module.paidReviewVerdict(c, { missionId: MISSION, baseVersion: 1, rows: [first] }));
    expect(value.kind).toBe("clear");
  });
  it("if an UNPROVABLE money state were read as free, a review whose charge cannot be proved would be allowed a second paid review", async () => {
    const m = await loadMutant(PAID, [{ from: 'if (state.kind === "unknown") return { kind: "unresolved", id: r.id, reason: "unverified" };', to: "" }]);
    const first = failedReview();
    const { value } = await solo<any>(opts([first], state(first, "unknown")), (c) => m.module.paidReviewVerdict(c, { missionId: MISSION, baseVersion: 1, rows: [first] }));
    expect(value.kind).toBe("clear");
  });
  it("without the storage check a PUBLISHED report is not shown free: the customer is told the review is unresolved though the report exists", async () => {
    const m = await loadMutant(PAID, [{ from: "if (await reviewReportPublished(client, input.missionId, input.baseVersion)) return { kind: \"report_published\", id: earlier[0].id };", to: "" }]);
    const first = failedReview();
    const objects = { ...ONE, [`${MISSION}/reviews/r0001.json`]: "{}" };
    const { value } = await solo<any>(opts([first], state(first, "charged"), objects), (c) => m.module.paidReviewVerdict(c, { missionId: MISSION, baseVersion: 1, rows: [first] }));
    expect(value.kind).toBe("unresolved");
  });
  it("if the creation did not call the guard, a second paid review request of the version would be MADE next to the charged one", async () => {
    const m = await loadMutant(ROW, [{ from: 'if (input.kind === "review" && input.paidReviewGuard) {', to: "if (false) {" }]);
    const first = failedReview();
    const { value, out } = await solo<any>(opts([first], state(first, "charged")), async (c) => {
      const card = reviewCard(1000);
      if (!card.ok) throw new Error("card");
      return m.module.createAddonRow(createSupabaseAddonRowStore(c, ME), { userId: ME, of: MISSION, kind: "review", baseVersion: 1, latestVersion: 1, request: { kind: "review" }, pricing: card.pricing, requestText: "طلب مراجعة", paidReviewGuard: async () => ({ kind: "unresolved", id: "x" }) });
    });
    expect(value.ok, "the mutant makes a second review").toBe(true);
    expect(rowsOf(out.rows)).toHaveLength(2);
  });
  it("if the approval guard did not look at the verdict, an approval of a second review request of the version would be let through", async () => {
    const m = await loadMutant(GUARD, [{ from: 'if (verdict.kind === "unresolved") return no(409, "review_unresolved", ADDON_CREATE_REFUSALS_AR.review_unresolved);', to: "" }]);
    const first = failedReview();
    const second = { ...addonRowOf({ status: "plan_ready", kind: "review", base: 1, attempt: 2 }), request_text: "طلب مراجعة", job_id: null, approved_at: null };
    const { value } = await solo<any>(opts([first, second], state(first, "charged")), (c) => m.module.guardApproval(c, { id: second.id, userId: ME }));
    expect(value).toEqual({ ok: true });
  });
  it("if the approval guard did not require this request to be the one that stays, a request next to a STARTED one would be let through (and its row has just been cancelled by the repair)", async () => {
    const m = await loadMutant(GUARD, [{ from: "if (!keeper || keeper.id !== input.id) return no(409, \"open_addon\", ADDON_CREATE_REFUSALS_AR.open_addon);", to: "" }]);
    const started = { ...addonRowOf({ status: "approved", kind: "review", base: 1 }), request_text: "طلب", job_id: "job_started", approved_at: "2026-11-03T09:00:00.000Z" };
    const waiting = { ...addonRowOf({ status: "plan_ready", kind: "review", base: 2 }), request_text: "طلب", job_id: null, approved_at: null };
    const { value } = await solo<any>(opts([started, waiting], () => undefined, objectsOf(v1)), (c) => m.module.guardApproval(c, { id: waiting.id, userId: ME }));
    expect(value).toEqual({ ok: true });
  });
});
